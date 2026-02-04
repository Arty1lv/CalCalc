/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered', reg))
      .catch(err => console.log('Service Worker registration failed', err));
  });
}

/* ---------- IndexedDB ---------- */
const DBNAME = "food-plan-db";
const DBVER = 9;

let statusTimer = null;

window.favoritesEnabled = false;
window.bmrMultiplier = 1.2;
window.goalKcal = -400;
window.proteinPerKg = 0.83;
window.waterGoalMl = 2000;
window.nettoMode = "nettonobmr";
window.autoSaveOnNewDay = true;

let currentFoodType = "ingredient";
window.currentFoodType = currentFoodType;
let pendingTabSwitch = null;

function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DBNAME, DBVER);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const oldVer = ev.oldVersion;

      if(!db.objectStoreNames.contains("meals")) db.createObjectStore("meals", {keyPath:"id"});
      if(!db.objectStoreNames.contains("activities")) db.createObjectStore("activities", {keyPath:"id"}); 
      if(!db.objectStoreNames.contains("logs")) db.createObjectStore("logs", {keyPath:"date"});
      if(!db.objectStoreNames.contains("shopping")) db.createObjectStore("shopping", {keyPath:"id"});     
      if(!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", {keyPath:"key"});
      if(!db.objectStoreNames.contains("notifications")) db.createObjectStore("notifications", {keyPath:"id"});

      if(oldVer < 7){
        const tx = req.transaction;
        const store = tx.objectStore("meals");
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if(cursor){
            const meal = cursor.value;
            let type = "ingredient";
            if(meal.category === "snack") type = "snack";

            const updatedMeal = {
              ...meal,
              type: meal.type ?? type,
              unit: meal.unit ?? "g",
              defaultAmount: meal.defaultAmount ?? (meal.portionG || 100)
            };
            cursor.update(updatedMeal);
            cursor.continue();
          }
        };
      }
      if(oldVer < 8){
        const tx = req.transaction;
        const meals = tx.objectStore("meals");
        meals.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if(cursor){
            const m = cursor.value;
            if(m.usageScore === undefined) m.usageScore = 0;
            cursor.update(m);
            cursor.continue();
          }
        };
        const acts = tx.objectStore("activities");
        acts.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if(cursor){
            const a = cursor.value;
            if(a.usageScore === undefined) a.usageScore = 0;
            cursor.update(a);
            cursor.continue();
          }
        };
        const meta = tx.objectStore("meta");
        meta.get("lastGlobalDecayDate").onsuccess = (ev) => {
          if(!ev.target.result){
            meta.put({key: "lastGlobalDecayDate", value: isoFromDate(new Date())});
          }
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function txGet(store, key){
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function txGetAll(store){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function txPut(store, value){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function txDelete(store, key){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function txClear(store){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
async function txBulkPut(store, arr){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for(const item of arr) os.put(item);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function metaGet(key){
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}
async function metaSet(key, value){
  await txPut("meta", {key, value});
}

/* ---------- State ---------- */
if (typeof window.meals === 'undefined') window.meals = [];
if (typeof window.activities === 'undefined') window.activities = [];
if (typeof window.todayMealEntries === 'undefined') window.todayMealEntries = [];
if (typeof window.todayActivityEntries === 'undefined') window.todayActivityEntries = [];
if (typeof window.recipeComponents === 'undefined') window.recipeComponents = [];

let todayWaterMl = 0;

// View date (editable): all actions apply to the selected date
let viewDateISO = null;
let themeTopToday = null;
let themeTopPast = null;
let themeDark = false;

function applyTheme(){
  document.body.classList.toggle("dark", !!themeDark);

  const baseToday = themeTopToday || "#2f6fed";
  const basePast  = themeTopPast  || "#ec4899";

  if(themeDark){
    document.documentElement.style.setProperty("--topToday", mixHex(baseToday, "#0b1220", 0.38));
    document.documentElement.style.setProperty("--topPast",  mixHex(basePast,  "#0b1220", 0.38));
  } else {
    document.documentElement.style.setProperty("--topToday", baseToday);
    document.documentElement.style.setProperty("--topPast",  basePast);
  }

  applyHeaderPalette();
}

function updateDynamicLabels() {
  const snackBtn = document.querySelector('.food-sub-tab[data-food-type="snack"]');
  if (snackBtn) {
    snackBtn.textContent = window.labelSnackBank || "Вкусняшки";
  }
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function hexToRgb(hex){
  const h = String(hex || "").trim().replace(/^#/, "");
  if(h.length === 3){
    return {r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16)};
  }
  if(h.length !== 6) return null;
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)) return null;
  return {r,g,b};
}
function rgbToHex(rgb){
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + to(rgb.r) + to(rgb.g) + to(rgb.b);
}
function mixHex(a, b, t){
  t = clamp01(t);
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if(!A || !B) return a || b || "#ffffff";
  return rgbToHex({
    r: A.r*(1-t) + B.r*t,
    g: A.g*(1-t) + B.g*t,
    b: A.b*(1-t) + B.b*t
  });
}
function yiqLuma(hex){
  const c = hexToRgb(hex);
  if(!c) return 0;
  return (c.r*299 + c.g*587 + c.b*114) / 1000;
}

function applyHeaderPalette(forceIsPast){
  const top = document.querySelector(".top");
  const isPast = (typeof forceIsPast === "boolean") ? forceIsPast : (top?.classList?.contains("past") || false);
  const base = isPast ? (themeTopPast || "#ec4899") : (themeTopToday || "#2f6fed");

  const pillBg = themeDark ? base : mixHex(base, "#ffffff", 0.86);

  let pillText;
  let pillMuted;
  if(themeDark){
    const l = yiqLuma(pillBg);
    pillText = (l >= 160) ? "#111111" : "#e5e7eb";
    pillMuted = mixHex(pillText, pillBg, 0.55);
  } else {
    pillText = "#111111";
    pillMuted = mixHex(base, "#111111", 0.70);
  }

  const pillBorder = themeDark ? mixHex(base, "#ffffff", 0.22) : mixHex(base, "#111111", 0.90);

  document.documentElement.style.setProperty("--pillBg", pillBg);
  document.documentElement.style.setProperty("--pillText", pillText);
  document.documentElement.style.setProperty("--pillBorder", pillBorder);
  document.documentElement.style.setProperty("--pillMuted", pillMuted);

  // Update PWA theme-color to match page background for a consistent look
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) {
    metaTheme.setAttribute('content', themeDark ? "#0b1220" : "#f6f7fb");
  }
}


function draftKey(iso){ return `draft:${iso}`; }

function fmtTimeHM(iso){
  if(!iso) return "";
  const d = new Date(iso);
  if(!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}

function safeNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function applyGlobalDecay(daysPassed){
  if(daysPassed <= 0) return;
  const multiplier = Math.pow(0.90, daysPassed);
  
  const meals = await txGetAll("meals");
  for(const m of meals){
    if(m.usageScore){
      m.usageScore *= multiplier;
    }
  }
  await txBulkPut("meals", meals);
  window.meals = meals;

  const acts = await txGetAll("activities");
  for(const a of acts){
    if(a.usageScore){
      a.usageScore *= multiplier;
    }
  }
  await txBulkPut("activities", acts);
  window.activities = acts;
}

async function checkAndApplyDecay(){
  if (typeof window !== 'undefined' && window.__TEST__) return Promise.resolve();
  const lastDecayStr = await metaGet("lastGlobalDecayDate");
  const todayISO = await getAppDateISO();
  
  if(!lastDecayStr) {
    await metaSet("lastGlobalDecayDate", todayISO);
    return;
  }
  
  if(todayISO > lastDecayStr){
    const d1 = new Date(lastDecayStr);
    const d2 = new Date(todayISO);
    const diffTime = Math.abs(d2 - d1);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if(diffDays > 0){
      await applyGlobalDecay(diffDays);
      await metaSet("lastGlobalDecayDate", todayISO);
    }
  }
}

async function incrementUsageScore(itemId){
  if (typeof window !== 'undefined' && window.__TEST__) return Promise.resolve();
  if(!itemId) return;
  await checkAndApplyDecay();

  const m = getMealById(itemId);
  if(m){
    m.usageScore = safeNum(m.usageScore) + 1;
    m.lastUsed = new Date().toISOString();
    await txPut("meals", m);
    
    if(m.type === "recipe" && m.ingredients){
      for(const ing of m.ingredients){
        await incrementUsageScore(ing.mealId);
      }
    }
    return;
  }

  const a = (window.activities || []).find(x => x.id === itemId);
  if(a){
    a.usageScore = safeNum(a.usageScore) + 1;
    a.lastUsed = new Date().toISOString();
    await txPut("activities", a);
  }
}

function scaleMealNutrients(meal, amount){
  const ratio = amount / 100;
  return {
    calories: Math.round(safeNum(meal.calories) * ratio),
    proteinG: safeNum(meal.proteinG) * ratio,
    fluidMl: safeNum(meal.fluidMl) * ratio
  };
}

function calculateRecipeTotals(components){
  let calories = 0, proteinG = 0, fluidMl = 0, weight = 0;
  for(const c of components){
    const m = getMealById(c.mealId);
    if(!m) continue;
    const scaled = scaleMealNutrients(m, c.amount);
    calories += scaled.calories;
    proteinG += scaled.proteinG;
    fluidMl += scaled.fluidMl;
    weight += safeNum(c.amount);
  }
  return { calories, proteinG, fluidMl, weight };
}

function detectRecipeLoop(targetId, currentRecipeId){
  if(!targetId || !currentRecipeId) return false;
  if(targetId === currentRecipeId) return true;
  
  const target = getMealById(targetId);
  if(!target || target.type !== "recipe" || !target.ingredients) return false;
  
  for(const ing of target.ingredients){
    if(detectRecipeLoop(ing.mealId, currentRecipeId)) return true;
  }
  return false;
}

async function copyToClipboard(text){
  const s = String(text ?? "");
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {}

  const ta = document.createElement("textarea");
  ta.value = s;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand("copy"); } catch {}
  ta.remove();
  return true;
}

function buildMealSnapshot(m){
  if(!m) return null;
  return {
    id: m.id,
    category: m.category,
    name: m.name,
    calories: Math.round(safeNum(m.calories)),
    proteinG: safeNum(m.proteinG),
    fluidMl: safeNum(m.fluidMl),
    kcalPer100g: Math.round(safeNum(m.calories)),
    portionG: (m.portionG === undefined || m.portionG === null || m.portionG === "") ? null : safeNum(m.portionG),
    usageScore: safeNum(m.usageScore)
  };
}

function mealFromEntry(e){
  const snap = e?.mealSnapshot || e?.snapshot || null;
  if(!snap) {
    const m = getMealById(e?.mealId);
    if(!m) return {id:e?.mealId ?? null, category:null, name:"??", calories:0, proteinG:0, fluidMl:0, kcalPer100g:null, portionG:null};
    const scaled = scaleMealNutrients(m, e.amount || 100);
    return {
      ...buildMealSnapshot(m),
      calories: scaled.calories,
      proteinG: scaled.proteinG,
      fluidMl: scaled.fluidMl
    };
  }
  
  // If we have a snapshot, it is per-100g density (based on new spec). 
  // We MUST scale it by the amount in the entry.
  const scaled = scaleMealNutrients(snap, e.amount || 100);
  return {
    ...snap,
    calories: scaled.calories,
    proteinG: scaled.proteinG,
    fluidMl: scaled.fluidMl
  };
}

function buildActivitySnapshot(a){
  if(!a) return null;
  return { id: a.id, name: a.name, kcalPerHour: Math.round(safeNum(a.kcalPerHour)), usageScore: safeNum(a.usageScore) };
}

function activityFromEntry(e){
  const snap = e?.activitySnapshot || e?.snapshot || null;
  if(snap) return snap;
  const a = (window.activities || []).find(x => x.id === e?.id);
  return a ? buildActivitySnapshot(a) : {id:e?.id ?? null, name:"??", kcalPerHour:0};
}

function setStatus(msg){
  const el = document.getElementById("status");
  el.textContent = msg;
  if(statusTimer) clearTimeout(statusTimer);
  if(msg) statusTimer = setTimeout(() => el.textContent = "", 4000);
}
function pad2(n){ return String(n).padStart(2,"0"); }
function isoFromDate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
/**
 * Generates HTML for a search input with a clear button.
 * @param {string} id - The ID for the input element.
 * @param {string} placeholder - The placeholder text.
 * @returns {string}
 */
function renderSearchInput(id, placeholder = "Поиск..."){
  return `
    <div class="search-container">
      <span class="search-icon">🔍</span>
      <input type="search" class="search-input" id="${id}" placeholder="${placeholder}" 
        autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" />
      <button class="search-clear hidden" id="${id}-clear" title="Очистить">✕</button>
    </div>
  `;
}

/**
 * Wires up the search input filtering logic.
 * @param {string} inputId - The ID of the search input.
 * @param {string} containerId - The ID of the container holding the cards.
 */
function wireSearch(inputId, containerId){
  const input = document.getElementById(inputId);
  const clearBtn = document.getElementById(`${inputId}-clear`);
  const container = document.getElementById(containerId);
  if(!input || !container) return;

  const handler = () => {
    const query = input.value.toLowerCase().trim();
    if(clearBtn){
      if(query) clearBtn.classList.remove("hidden");
      else clearBtn.classList.add("hidden");
    }
    applySearchFilter(containerId, query);
  };

  input.addEventListener("input", handler);
  clearBtn?.addEventListener("click", () => {
    input.value = "";
    handler();
    input.focus();
  });
}

/**
 * Toggles visibility of cards based on search query.
 * @param {string} containerId - The ID of the container holding the cards.
 * @param {string} query - The search query.
 */
function applySearchFilter(containerId, query){
  const container = document.getElementById(containerId);
  if(!container) return;
  
  const cards = container.querySelectorAll(".card");
  const q = query.toLowerCase().trim();

  cards.forEach(card => {
    if(!q){
      card.classList.remove("hidden");
      return;
    }
    
    // Find the name div. It's usually the first div with font-weight:900
    // We search specifically within the card's header area if possible, 
    // but a general search for the first font-weight:900 div works for both Meal and Activity cards.
    const nameDiv = card.querySelector("div[style*='font-weight:900'], div[style*='font-weight: 900']");
    const name = nameDiv ? nameDiv.textContent.toLowerCase() : "";
    
    if(name.includes(q)){
      card.classList.remove("hidden");
    } else {
      card.classList.add("hidden");
    }
  });
}

function escapeHtml(s){
  return String(s ?? "")
    .replace(/[&<>"']/g, m => ({'&':"&amp;",'<':"&lt;",'>':"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}
function uid(prefix){
  if(crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ---------- Date debug ---------- */
async function getAppDateISO(){
  const dbg = await metaGet("debug.enabled");
  if(dbg){
    let cur = await metaGet("debug.dateISO");
    if(!cur) cur = isoFromDate(new Date());
    await metaSet("debug.dateISO", cur);
    return cur;
  }
  return isoFromDate(new Date());
}
async function advanceAppDateIfDebug(){
  const dbg = await metaGet("debug.enabled");
  if(!dbg) return;
  const curISO = await metaGet("debug.dateISO") || isoFromDate(new Date());
  const [y,m,d] = curISO.split("-").map(x => parseInt(x,10));
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate()+1);
  await metaSet("debug.dateISO", isoFromDate(dt));
}
async function refreshDateUI(){
  const todayISO = await getAppDateISO();
  if(!viewDateISO) viewDateISO = todayISO;

  const dbg = await metaGet("debug.enabled");

  document.getElementById("uiDate").textContent = viewDateISO;

  const tags = [];
  if(dbg) tags.push("debug");
  if(viewDateISO !== todayISO) tags.push("просмотр");
  document.getElementById("uiDebugTag").textContent = tags.length ? ("(" + tags.join(", ") + ")") : "";

  const top = document.querySelector(".top");
  if(top){
    const isPast = (viewDateISO !== todayISO);
    top.classList.toggle("past", isPast);
    applyHeaderPalette(isPast);
  } else {
    applyHeaderPalette(viewDateISO !== todayISO);
  }

  const dp = document.getElementById("datePicker");
  if(dp) dp.value = viewDateISO;
}

/* ---------- Calories ---------- */
function getMealById(id){ return (window.meals || []).find(m => m.id === id); }

function getRecipeDependencies(recipeId, visited = new Set()){
  const root = getMealById(recipeId);
  if(!root) return [];
  
  if(visited.has(recipeId)) return [];
  visited.add(recipeId);
  
  let results = [root];
  
  if(root.type === "recipe" && Array.isArray(root.ingredients)){
    for(const ing of root.ingredients){
      const subDeps = getRecipeDependencies(ing.mealId, visited);
      for(const sd of subDeps){
        if(!results.some(r => r.id === sd.id)){
          results.push(sd);
        }
      }
    }
  }
  
  return results;
}

function serializeBundle(rootRecipeId, items){
  const root = items.find(x => x.id === rootRecipeId);
  const header = `Recipe: ${root?.name || "Shared Items"}\n---\n`;
  const payload = {
    v: 2,
    root: rootRecipeId,
    items: items
  };
  return header + JSON.stringify(payload);
}

function compressPayload(obj){
  const lz = window.LZString;
  return lz.compressToEncodedURIComponent(JSON.stringify(obj));
}

    function decompressPayload(str){
      const lz = window.LZString;
      const json = lz.decompressFromEncodedURIComponent(str);
      return JSON.parse(json);
    }

    async function parseBundle(text){  let data;
  const t = text.trim();
  
  try {
    if(t.startsWith("{")){
      data = JSON.parse(t);
    } else if(t.includes("---")){
      const jsonPart = t.split("---")[1].trim();
      data = JSON.parse(jsonPart);
    } else {
      // Try decompressing
      data = await decompressPayload(t);
    }
  } catch {
    // If it didn't start with { or have ---, it might be raw JSON that's not compressed
    try { data = JSON.parse(t); } catch {
       throw new Error("Invalid bundle format or corrupted data");
    }
  }
  
  if(!data || data.v !== 2){
    throw new Error("Unsupported bundle version");
  }
  return data;
}

function analyzeImport(bundle){
  const items = bundle.items || [];
  const results = [];
  
  for(const imp of items){
    // 1. Try exact match
    const exact = (window.meals || []).find(m => 
      m.name === imp.name && 
      safeNum(m.calories) === safeNum(imp.calories) &&
      safeNum(m.proteinG) === safeNum(imp.proteinG) &&
      m.type === imp.type
    );
    
    if(exact){
      results.push({ item: imp, status: 'MATCH_EXACT', localId: exact.id });
      continue;
    }
    
    // 2. Try name match (Conflict)
    const nameMatch = (window.meals || []).find(m => m.name === imp.name && m.type === imp.type);
    if(nameMatch){
      results.push({ item: imp, status: 'MATCH_NAME', localId: nameMatch.id });
      continue;
    }
    
    // 3. New item
    results.push({ item: imp, status: 'NEW', localId: null });
  }
  
  return results;
}

class ResolutionState {
  constructor(){
    this.mapping = {}; // importId -> localId
  }
  addMapping(importId, localId){
    this.mapping[importId] = localId;
  }
  getLocalId(importId){
    return this.mapping[importId] || null;
  }
  hasMapping(importId){
    return this.mapping.hasOwnProperty(importId);
  }
  clear(){
    this.mapping = {};
  }
}

async function openShareModal(recipeId){

  const items = getRecipeDependencies(recipeId);

  if(!items.length) return;

  

  const root = items.find(x => x.id === recipeId);

  const bundleText = serializeBundle(recipeId, items);

  

  const back = document.getElementById("shareModalBack");

  const nameEl = document.getElementById("shareItemName");

  

  if(nameEl) nameEl.textContent = root?.name || "Блюдо";

  

    // Show modal

  

    if(back) back.style.display = "block";

  

    pushModalState("shareModalBack");

  

  

  

    // Share Link wiring

  

    const shareLinkBtn = document.getElementById("btnShareLink");

  

    if(shareLinkBtn){

  

      const newBtn = shareLinkBtn.cloneNode(true);

  

      shareLinkBtn.parentNode.replaceChild(newBtn, shareLinkBtn);

  

      

  

      newBtn.addEventListener("click", () => {

  

        // Trigger the link share

  

        window.shareRecipeLink(root, items);

  

      });

  

    }

  

    

  

    // Clipboard wiring

  

    const copyBtn = document.getElementById("btnCopyShareText");  const originalText = copyBtn.textContent;
  
  // Clear any old listener by cloning
  const newBtn = copyBtn.cloneNode(true);
  copyBtn.parentNode.replaceChild(newBtn, copyBtn);
  
  newBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(bundleText);
    if(ok){
      newBtn.textContent = "Скопировано!";
      setTimeout(() => { newBtn.textContent = originalText; }, 2000);
    }
  });
}

function wireShareModal(){
  document.getElementById("closeShareBtn")?.addEventListener("click", () => {
    const menu = document.getElementById("shareModalBack");
    if (menu && menu.style.display === "block") {
      menu.style.display = "none";
      if (history.state && history.state.modals && history.state.modals.includes("shareModalBack")) {
        history.back();
      } else {
        syncUI(history.state);
      }
    }
  });
}

let importBundle = null;
/** @type {Array|null} */
let importAnalysis = null;
/** @type {ResolutionState|null} */
let importResolution = null;

// Expose for testing
/** @returns {Array|null} */
window._getImportAnalysis = () => importAnalysis;
/** @param {Array|null} val */
window._setImportAnalysis = (val) => { importAnalysis = val; };
/** @returns {ResolutionState|null} */
window._getImportResolution = () => importResolution;
/** @param {ResolutionState|null} val */
window._setImportResolution = (val) => { importResolution = val; };

    async function openImportModal(){
      const back = document.getElementById("importModalBack");
      if(back) back.style.display = "block";
      pushModalState("importModalBack");
      
      // Reset UI state
      document.getElementById("importStepInput").classList.remove("hidden");
      document.getElementById("importStepReview").classList.add("hidden");
      document.getElementById("btnExecuteImport").classList.add("hidden");
      document.getElementById("importPasteText").value = "";
      
      importBundle = null;
      importAnalysis = null;
      importResolution = new ResolutionState();
    }
async function handleImportPayload(text){
  try {
    const bundle = await parseBundle(text);
    importBundle = bundle;
    importAnalysis = analyzeImport(bundle);
    
    // Switch to review step
    document.getElementById("importStepInput").classList.add("hidden");
    document.getElementById("importStepReview").classList.remove("hidden");
    document.getElementById("btnExecuteImport").classList.remove("hidden");
    
    renderImportReview();
  } catch(e) {
    alert("Ошибка парсинга: " + e.message);
  }
}

function renderImportReview(){
  const list = document.getElementById("importReviewList");
  if(!list || !importAnalysis) return;
  
  list.innerHTML = `<div class="muted" style="margin-bottom:10px">Найдено элементов: ${importAnalysis.length}</div>`;
  
  importAnalysis.forEach((entry, idx) => {
    const { item, status, localId } = entry;
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "8px";
    
    let statusIcon = "[OK]";
    let statusColor = "#16a34a";
    let statusText = "Новый элемент";
    
    if(status === 'MATCH_EXACT') {
      statusText = "Точная копия (будет связан)";
      importResolution.addMapping(item.id, localId);
      entry.selectedAction = 'USE_LOCAL';
    } else if(status === 'MATCH_NAME') { 
      statusIcon = "[!]"; 
      statusColor = "#ea580c"; 
      statusText = "Конфликт имени";
      importResolution.addMapping(item.id, localId); // Default to local
      entry.selectedAction = 'USE_LOCAL';
    } else {
      // NEW
      importResolution.addMapping(item.id, null); // Will generate ID on save
      entry.selectedAction = 'CREATE_NEW';
    }
    
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div>
          <div style="font-weight:900">${escapeHtml(item.name)}</div>
          <div class="muted" style="font-size:12px">${item.type === 'recipe' ? 'Рецепт' : 'Ингредиент'} - ${Math.round(item.calories)} ккал</div>
        </div>
        <div style="color:${statusColor}; font-weight:900" title="${statusText}">${statusIcon}</div>
      </div>
      <div id="resolution_row_${idx}" style="margin-top:10px; border-top:1px solid #eee; padding-top:10px"></div>
    `;
    
    list.appendChild(card);
    renderResolutionRow(idx, entry);
  });
}

function renderResolutionRow(idx, entry){
  const container = document.getElementById(`resolution_row_${idx}`);
  if(!container) return;
  
  const { status, localId, manualLink } = entry;
  
  if(manualLink){
    const local = getMealById(manualLink);
    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div style="font-size:12px">Связано с: <b>${local.name}</b></div>
        <button class="btn-text btn-search-link" data-idx="${idx}" style="font-size:11px; color:#3b82f6">Изменить</button>
      </div>
    `;
    container.querySelector(".btn-search-link").addEventListener("click", () => renderSearchUI(idx, entry));
    return;
  }
  
  if(status === 'NEW'){
    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div class="muted" style="font-size:12px">Будет создан как новый элемент.</div>
        <button class="btn-text btn-search-link" data-idx="${idx}" style="font-size:11px; color:#3b82f6">Связать вручную</button>
      </div>
    `;
    container.querySelector(".btn-search-link").addEventListener("click", () => renderSearchUI(idx, entry));
    return;
  }
  
  if(status === 'MATCH_NAME' || status === 'MATCH_EXACT'){
    const local = getMealById(localId);
    const isExact = status === 'MATCH_EXACT';
    
    const msg = isExact 
        ? `Данные полностью совпадают с вашим "${local.name}".`
        : `У вас уже есть "${local.name}" с другими данными (${local.calories} ккал).`;

    container.innerHTML = `
      <div class="muted" style="font-size:12px; margin-bottom:8px">${msg}</div>
      <div style="display:flex; gap:8px">
        <select class="resolution-select" data-idx="${idx}" style="flex:1; font-size:12px">
          <option value="USE_LOCAL" ${entry.selectedAction === 'USE_LOCAL' ? 'selected' : ''}>Использовать мой вариант</option>
          <option value="CREATE_NEW" ${entry.selectedAction === 'CREATE_NEW' ? 'selected' : ''}>Создать копию (Импорт)</option>
          ${!isExact ? `<option value="OVERWRITE" ${entry.selectedAction === 'OVERWRITE' ? 'selected' : ''}>Перезаписать мой вариант (!)</option>` : ''}
        </select>
        <button class="btn secondary btn-search-link" title="Поиск в базе" style="padding:0 10px">🔍</button>
      </div>
      <div class="overwrite-warning hidden" id="warn_${idx}" style="color:#dc2626; font-size:11px; margin-top:4px">
        Внимание: Изменения затронут все ваши рецепты!
      </div>
    `;
    
    const sel = container.querySelector("select");
    sel.addEventListener("change", (e) => {
      const val = e.target.value;
      const warn = document.getElementById(`warn_${idx}`);
      if(val === 'OVERWRITE') warn?.classList.remove("hidden");
      else warn?.classList.add("hidden");
      
      handleResolutionChange(idx, val);
    });

    container.querySelector(".btn-search-link").addEventListener("click", () => renderSearchUI(idx, entry));
  }
}

/**
 * Renders a search interface within a resolution row to allow manual linking.
 * @param {number} idx - Index of the item in importAnalysis.
 * @param {Object} entry - The import analysis entry.
 */
function renderSearchUI(idx, entry){
  const container = document.getElementById(`resolution_row_${idx}`);
  if(!container) return;

  container.innerHTML = `
    <div class="resolution-search-box" style="margin-top:5px">
      <input type="text" class="resolution-search-input" placeholder="Поиск в базе..." style="width:100%; font-size:12px; padding:6px; border:1px solid #ddd; border-radius:4px">
      <div class="resolution-search-results" style="max-height:120px; overflow-y:auto; background:#f9f9f9; border:1px solid #ddd; border-top:none; border-radius:0 0 4px 4px; font-size:12px"></div>
      <button class="btn-text btn-cancel-search" style="margin-top:5px; font-size:11px">Отмена</button>
    </div>
  `;

  const input = container.querySelector(".resolution-search-input");
  const resultsDiv = container.querySelector(".resolution-search-results");
  const cancelBtn = container.querySelector(".btn-cancel-search");

  input.focus();

  input.addEventListener("input", () => {
    const query = input.value.toLowerCase().trim();
    if(!query) {
      resultsDiv.innerHTML = "";
      return;
    }

    const matches = (window.meals || []).filter(m => 
      m.name.toLowerCase().includes(query) || 
      (m.type === 'recipe' && 'рецепт'.includes(query))
    ).slice(0, 5);

    resultsDiv.innerHTML = matches.map(m => `
      <div class="search-result-item" data-id="${m.id}" style="padding:6px; cursor:pointer; border-bottom:1px solid #eee">
        ${m.name} <span class="muted">(${m.calories} ккал)</span>
      </div>
    `).join("");

    resultsDiv.querySelectorAll(".search-result-item").forEach(el => {
      el.addEventListener("click", () => {
        const localId = el.getAttribute("data-id");
        entry.manualLink = localId;
        importResolution.addMapping(entry.item.id, localId);
        renderResolutionRow(idx, entry);
      });
    });
  });

  cancelBtn.addEventListener("click", () => {
    renderResolutionRow(idx, entry);
  });
}

function handleResolutionChange(idx, action){
  const entry = importAnalysis[idx];
  if(!entry) return;
  
  entry.selectedAction = action;
  if(action === 'USE_LOCAL' || action === 'OVERWRITE'){
    importResolution.addMapping(entry.item.id, entry.localId);
    delete entry.manualLink;
  } else if(action === 'CREATE_NEW'){
    importResolution.addMapping(entry.item.id, null); // Force new
    delete entry.manualLink;
  }
}

async function executeImport(bundle, resState, analysis){
  const items = bundle.items || [];
  const resolutionMap = resState instanceof ResolutionState ? resState.mapping : resState;
  
  // 1. Pre-generate IDs for all items that will be NEWly created
  // This ensures that when we remap ingredients, we already know the target IDs.
  for(const imp of items){
    const entry = (analysis || []).find(a => a.item.id === imp.id);
    const action = entry ? entry.selectedAction : null;
    
    const isNew = !resolutionMap[imp.id] || action === 'CREATE_NEW' || (entry && entry.status === 'NEW' && !entry.manualLink);
    
    if(isNew && !resolutionMap[imp.id]){
      resolutionMap[imp.id] = uid("m");
    }
  }

  // 2. Process all items
  const ingredients = items.filter(x => x.type !== 'recipe');
  const recipes = items.filter(x => x.type === 'recipe');
  
  const processItem = async (imp) => {
    const entry = (analysis || []).find(a => a.item.id === imp.id);
    const action = entry ? entry.selectedAction : null;
    const localId = resolutionMap[imp.id];
    
    // An item is considered new if it wasn't in the resolution map initially 
    // OR if the user explicitly chose to create a new copy.
    // Note: localId might already be a pre-generated "m-..." ID from step 1.
    const isExplicitNew = action === 'CREATE_NEW' || (entry && entry.status === 'NEW' && !entry.manualLink);
    const isImplicitNew = localId && String(localId).startsWith("m-") && !getMealById(localId);

    if(action === 'OVERWRITE'){
      // ... existing overwrite logic ...
      const existing = getMealById(localId);
      if(existing){
        Object.assign(existing, {
          ...imp,
          id: localId,
          updatedAt: new Date().toISOString()
        });
        await txPut("meals", existing);
      }
    } else if(isExplicitNew || isImplicitNew){
      // Create new
      let name = imp.name;
      if(action === 'CREATE_NEW' && entry && entry.status !== 'NEW') {
        name += " (Импорт)";
      }
      
      const newItem = {
        ...imp,
        id: localId,
        name: name,
        updatedAt: new Date().toISOString()
      };
      await txPut("meals", newItem);
    }
  };

  for(const imp of ingredients) await processItem(imp);
  
  // 3. Second pass: Recipes (handle remapping)
  for(const imp of recipes){
    const remappedIngredients = (imp.ingredients || []).map(ing => ({
      ...ing,
      mealId: resolutionMap[ing.mealId] || ing.mealId
    }));

    const impWithRemapped = { ...imp, ingredients: remappedIngredients };
    await processItem(impWithRemapped);
  }

  window.meals = await txGetAll("meals");
}

    async function handleFileImport(file){
      if(!file) return;
      try {
        const text = await file.text();
        await handleImportPayload(text);
      } catch(err) {
        console.error("File import failed:", err);
        alert("Не удалось прочитать файл: " + err.message);
      }
    }
    window.handleFileImport = handleFileImport;

        function wireImportModal(){

          document.getElementById("closeImportBtn")?.addEventListener("click", () => {

            const back = document.getElementById("importModalBack");

            if (back && back.style.display === "block") {

              back.style.display = "none";

              if (history.state && history.state.modals && history.state.modals.includes("importModalBack")) {

                history.back();

              } else {

                syncUI(history.state);

              }

            }

          });

          

          document.getElementById("btnImportClipboard")?.addEventListener("click", async () => {

            if (!window.isSecureContext) {

              alert("Доступ к буферу обмена требует безопасного соединения (HTTPS или localhost). Пожалуйста, вставьте текст вручную.");

              return;

            }

            try {

              const text = await navigator.clipboard.readText();

              if(text) await handleImportPayload(text);

            } catch { 

              alert("Нет доступа к буферу обмена. Убедитесь, что вы разрешили доступ в настройках браузера или вставьте текст вручную."); 

            }

          });

          

          const btnFile = document.getElementById("btnImportFile");

          const inputFile = document.getElementById("inputImportFile");

          

          btnFile?.addEventListener("click", () => inputFile?.click());

          inputFile?.addEventListener("change", async (e) => {

            const file = e.target.files[0];

            if (file) {

              await handleFileImport(file);

              // Clear input so same file can be re-selected if needed

              e.target.value = "";

            }

          });

          

          document.getElementById("importPasteText")?.addEventListener("input", () => {
    const val = document.getElementById("importPasteText").value.trim();
    if(val.startsWith("{") || val.includes("---")) {
      handleImportPayload(val);
    }
  });

  document.getElementById("btnExecuteImport")?.addEventListener("click", async () => {
    if(!importBundle || !importResolution) return;
    try {
      await executeImport(importBundle, importResolution, importAnalysis);
      setStatus("Импорт завершен успешно.");
      
      // Close modal
      const back = document.getElementById("importModalBack");
      if(back) {
        back.style.display = "none";
        document.body.classList.remove("modalOpen");
        if (history.state && history.state.modals && history.state.modals.includes("importModalBack")) {
          history.back();
        }
      }
      
      // Reset state
      importBundle = null;
      importAnalysis = null;
      importResolution = new ResolutionState();
      
      renderFoodAll();
    } catch(e) {
      alert("Ошибка при выполнении импорта: " + e.message);
    }
  });
}

function calcEatKcal(){
  let sum = 0;
  for(const e of (window.todayMealEntries || [])){
    const m = mealFromEntry(e);
    sum += safeNum(m?.calories);
  }
  return Math.round(sum);
}

function calcEatProteinG(){
  let sum = 0;
  for(const e of (window.todayMealEntries || [])){
    const m = mealFromEntry(e);
    sum += safeNum(m?.proteinG);
  }
  return Math.round(sum);
}
function calcFluidFromMealsMl(){
  let sum = 0;
  for(const e of (window.todayMealEntries || [])){
    const m = mealFromEntry(e);
    sum += safeNum(m?.fluidMl);
  }
  return Math.round(sum);
}
function calcProteinTargetG(){
  const w = Number(document.getElementById("weight")?.value || 0);
  const ppk = Number(window.proteinPerKg ?? 0.83);
  if(!Number.isFinite(w) || w <= 0) return 0;
  if(!Number.isFinite(ppk) || ppk <= 0) return 0;
  return Math.round(w * ppk);
}
function calcWaterGoalMl(){
  const g = Number(window.waterGoalMl ?? 2000);
  return (Number.isFinite(g) && g >= 0) ? Math.round(g) : 2000;
}
function calcWaterTotalMl(){
  return Math.round(Number(todayWaterMl || 0) + calcFluidFromMealsMl());
}

function calcBurnKcalExercise(){
  let sum = 0;
  for(const e of (window.todayActivityEntries || [])){
    const a = activityFromEntry(e);
    sum += (safeNum(a?.kcalPerHour) * safeNum(e?.minutes) / 60);
  }
  return Math.round(sum);
}
function calcBasalKcalPerDayFrom(weight){
  const h = Number(document.getElementById("setHeight")?.value || 0);
  const age = Number(document.getElementById("setAge")?.value || 0);
  const sex = String(document.getElementById("setSex")?.value || "female");
  const w = Number(weight || 0) || 55;
  if(!h || !age || !w) return 0;
  const s = (sex === "male") ? 5 : -161;
  const base = 10*w + 6.25*h - 5*age + s;
  const mult = Number(window.bmrMultiplier || 1);
  return Math.round(base * mult);
}
function calcBasalKcalPerDay(){
  const w = Number(document.getElementById("weight")?.value || 55);
  return calcBasalKcalPerDayFrom(w);
}
function calcDayLimitKcal(){
  const basal = calcBasalKcalPerDay();
  const burnExercise = calcBurnKcalExercise();
  const goal = Number(window.goalKcal || 0);
  return Math.round(basal + burnExercise + goal);
}
function updateLimitBar(eat, limit){
  const bar = document.getElementById("limitBar");
  if(!limit || !Number.isFinite(limit) || limit <= 0){ bar.style.width = "0%"; return; }
  const pct = eat / limit * 100;
  const pctClamped = Math.max(0, Math.min(100, pct));
  bar.style.width = pctClamped.toFixed(0) + "%";
}
function applyNettoMode(eat, burnExercise, basal, limit){
  const mode = String(window.nettoMode || "nettonobmr");
  const nettoTitle = document.getElementById("nettoTitle");
  if(mode === "consumedlimit"){
    nettoTitle.textContent = "Съедено / лимит";
    document.getElementById("todayNet").textContent = `${eat} / ${limit}`;
    document.getElementById("nettoLabel").textContent = "";
    return;
  }
  if(mode === "remaining"){
    nettoTitle.textContent = "Осталось";
    document.getElementById("todayNet").textContent = Math.round((limit || 0) - eat);
    document.getElementById("nettoLabel").textContent = "ккал";
    return;
  }
  if(mode === "nettowithbmr"){
    nettoTitle.textContent = "Нетто (с BMR)";
    document.getElementById("todayNet").textContent = eat - burnExercise - basal;
    document.getElementById("nettoLabel").textContent = "ккал";
    return;
  }
  nettoTitle.textContent = "Нетто";
  document.getElementById("todayNet").textContent = eat - burnExercise;
  document.getElementById("nettoLabel").textContent = "ккал";
}
function updateTopTotals(){
  const meals = window.todayMealEntries || [];
  const acts = window.todayActivityEntries || [];
  const sets = window.settings || {};
  
  const eat = calcEatKcal();
  const burnExercise = calcBurnKcalExercise();
  const basal = calcBasalKcalPerDay();
  const limit = calcDayLimitKcal();
  document.getElementById("todayEat").textContent = eat;
  document.getElementById("todayBurn").textContent = burnExercise;
  document.getElementById("bmrInfo").textContent = basal ? `BMR: ${basal} (x${Number(window.bmrMultiplier||1).toFixed(2)})` : "";
  applyNettoMode(eat, burnExercise, basal, limit);
  updateLimitBar(eat, limit);

  const pEat = calcEatProteinG();
  const pTarget = calcProteinTargetG();
  const wTotal = calcWaterTotalMl();
  const wGoal = calcWaterGoalMl();
  const pEl = document.getElementById("uiProtein");
  const wEl = document.getElementById("uiWater");
  if(pEl) pEl.textContent = `${pEat}/${pTarget} г`;
  if(wEl) wEl.textContent = `${wTotal}/${wGoal} мл`;

}
function cycleNettoMode(){
  const order = ["nettonobmr","nettowithbmr","consumedlimit","remaining"];
  const cur = String(window.nettoMode || order[0]);
  const idx = Math.max(0, order.indexOf(cur));
  const next = order[(idx+1) % order.length];
  window.nettoMode = next;
  const sel = document.getElementById("nettoMode");
  if(sel) sel.value = next;
  metaSet("settings.nettoMode", next);
  updateTopTotals();
}

/* ---------- Draft ---------- */
async function saveDraft(){
  const date = viewDateISO || await getAppDateISO();
  const draft = {
    date,
    todayMealEntries: Array.from(window.todayMealEntries || []),
    todayActivityEntries: Array.from(window.todayActivityEntries || []),
    todayWaterMl: Number(todayWaterMl || 0),
    weight: document.getElementById("dashWeight")?.value || document.getElementById("weight").value,
    steps: document.getElementById("dashSteps").value,
    notes: document.getElementById("notes").value
  };
  await metaSet(draftKey(date), draft);
}
async function migrateOldDraftToMealEntries(draft){
  const out = [];
  const seen = new Set();
  if(Array.isArray(draft?.selectedMealIds)){
    for(const id of draft.selectedMealIds){
      if(!id || seen.has(id)) continue;
      out.push({entryId: uid("e"), mealId: id});
      seen.add(id);
    }
  }
  if(draft?.snackCounts && typeof draft.snackCounts === "object"){
    for(const [id, cnt] of Object.entries(draft.snackCounts)){
      const n = Math.max(0, Math.round(Number(cnt || 0)));
      for(let i=0;i<n;i++) out.push({entryId: uid("e"), mealId: id});
    }
  }
  return out;
}
function normalizeMealEntries(entries){
  const arr = Array.isArray(entries) ? entries : [];
  return arr.map(e => {
    if(!e) return null;
    const entryId = e.entryId || uid("e");
    const mealId = e.mealId || e.id || null;
    const snap = e.mealSnapshot || e.snapshot || (mealId ? buildMealSnapshot(getMealById(mealId)) : null);
    return { ...e, entryId, mealId, mealSnapshot: snap, createdAt: e.createdAt || e.addedAt || null };
  }).filter(Boolean);
}

function normalizeActivityEntries(entries){
  const arr = Array.isArray(entries) ? entries : [];
  return arr.map(e => {
    if(!e) return null;
    const id = e.id || e.actId || e.activityId || null;
    const minutes = Math.round(safeNum(e.minutes));
    const snap = e.activitySnapshot || e.snapshot || (id ? buildActivitySnapshot((window.activities || []).find(x=>x.id===id)) : null);
    return { ...e, id, minutes, activitySnapshot: snap, createdAt: e.createdAt || e.addedAt || null };
  }).filter(Boolean);
}

async function migrateLegacyDraftOnce(){
  const legacy = await metaGet("draft");
  if(!legacy || !legacy.date) return;
  const key = draftKey(legacy.date);
  const existing = await metaGet(key);
  if(existing) return;
  await metaSet(key, legacy);
  await metaSet("draft", null);
}

async function loadDraft(){
  const savedWeight = await metaGet("profile.weight");
  const date = viewDateISO || await getAppDateISO();

  const draft = await metaGet(draftKey(date));
  if(draft && draft.date === date){
    if(Array.isArray(draft.todayMealEntries)) window.todayMealEntries = normalizeMealEntries(draft.todayMealEntries);
    else window.todayMealEntries = normalizeMealEntries(await migrateOldDraftToMealEntries(draft));

    window.todayActivityEntries = normalizeActivityEntries(draft.todayActivityEntries);
    todayWaterMl = Number(draft.todayWaterMl || 0);

    const wValue = (draft.weight ?? "");
    document.getElementById("weight").value = wValue;
    const dw = document.getElementById("dashWeight");
    if(dw) dw.value = wValue;

    document.getElementById("dashSteps").value = (draft.steps ?? "");
    document.getElementById("notes").value = (draft.notes ?? "");
  } else {
    const log = await txGet("logs", date);
    if(log){
      window.todayMealEntries = normalizeMealEntries(log.mealEntries || []);
      window.todayActivityEntries = normalizeActivityEntries(log.activityEntries || []);
      todayWaterMl = Number(log.waterMlExtra || 0);

      const wValue = (log.weight ?? "");
      document.getElementById("weight").value = wValue;
      const dw = document.getElementById("dashWeight");
      if(dw) dw.value = wValue;

      document.getElementById("dashSteps").value = (log.steps ?? "");
      document.getElementById("notes").value = (log.notes ?? "");
    } else {
      window.todayMealEntries = [];
      window.todayActivityEntries = [];
      todayWaterMl = 0;
      document.getElementById("dashSteps").value = "";
      document.getElementById("notes").value = "";
      const dw = document.getElementById("dashWeight");
      if(dw) dw.value = "";
    }
  }

  const weightInput = document.getElementById("weight");
  if(!String(weightInput.value || "").trim() && savedWeight !== null && savedWeight !== undefined){
    weightInput.value = String(savedWeight);
    const dw = document.getElementById("dashWeight");
    if(dw) dw.value = weightInput.value;
  }
}
async function autoSaveDraftIfDateChanged(){
  const todayISO = await getAppDateISO();
  const lastOpened = await metaGet("app.lastOpenedDateISO");

  if(lastOpened && lastOpened !== todayISO){
    if(window.autoSaveOnNewDay){
      const log = await txGet("logs", lastOpened);
      if(!log){
        const draft = await metaGet(draftKey(lastOpened));
        if(draft){
          console.log(`Auto-saving log for ${lastOpened}`);
          await saveDayLogFromDraft(draft, true);
          if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
            renderLogs();
          } else {
            await renderLogs();
          }
        }
      }
    }
  }
  await metaSet("app.lastOpenedDateISO", todayISO);
}

async function saveDayLogFromDraft(draft, autoSaved = false) {
  const { date, todayMealEntries: mealEntries, todayActivityEntries: activityEntries, todayWaterMl: waterMlExtra, weight, steps, notes } = draft;

  const oldMealEntries = window.todayMealEntries;
  const oldActivityEntries = window.todayActivityEntries;
  const oldWater = todayWaterMl;
  
  window.todayMealEntries = normalizeMealEntries(mealEntries);
  window.todayActivityEntries = normalizeActivityEntries(activityEntries);
  todayWaterMl = Number(waterMlExtra || 0);

  const eat = calcEatKcal();
  const burnExercise = calcBurnKcalExercise();
  const basal = calcBasalKcalPerDayFrom(Number(weight) || 55);
  const burnTotal = burnExercise + basal;
  const goal = Number(window.goalKcal || 0);
  const limit = Math.round(basal + burnExercise + goal);
  const remaining = Math.round(limit - eat);

  const proteinEatG = calcEatProteinG();
  const proteinTargetG = Math.round((Number(weight) || 55) * (window.proteinPerKg || 0.83));
  const fluidFromMealsMl = calcFluidFromMealsMl();
  const waterGoalMl = calcWaterGoalMl();
  const waterMl = Math.round(todayWaterMl + fluidFromMealsMl);

  await txPut("logs", {
    date,
    weight,
    steps,
    mealEntries: window.todayMealEntries,
    activityEntries: window.todayActivityEntries,
    eatCalories: eat,
    burnExerciseCalories: burnExercise,
    basalCalories: basal,
    burnCalories: burnTotal,
    netCalories: eat - burnTotal,
    goalKcal: goal,
    limitCalories: limit,
    remainingCalories: remaining,
    proteinEatG,
    proteinTargetG,
    waterMl,
    waterGoalMl,
    waterMlExtra: todayWaterMl,
    fluidFromMealsMl,
    notes,
    autoSaved,
    updatedAt: new Date().toISOString()
  });

  window.todayMealEntries = oldMealEntries;
  window.todayActivityEntries = oldActivityEntries;
  todayWaterMl = oldWater;

  if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
    renderLogs();
  } else {
    await renderLogs();
  }
}

/* ---------- Render food ---------- */
function sortMaybeFav(list){
  const copy = list.slice();
  
  copy.sort((a, b) => {
    // 1. Favorites (highest priority if enabled)
    if(window.favoritesEnabled){
      const fav = Number(!!b.favorite) - Number(!!a.favorite);
      if(fav !== 0) return fav;
    }
    
    // 2. Usage Score (if frequency sorting enabled)
    if(window.sortFreqEnabled){
      const scoreA = safeNum(a.usageScore);
      const scoreB = safeNum(b.usageScore);
      if(scoreB !== scoreA) return scoreB - scoreA;
    }
    
    // 3. Alphabetical (fallback/tie-breaker)
    return String(a.name).localeCompare(String(b.name), "ru");
  });
  
  return copy;
}
function notificationCardHtml(n) {
  const nextTime = n.nextFiringTime ? fmtTimeHM(new Date(n.nextFiringTime)) : "Не запланировано";
  
  let triggerText = "Специальный";
  if (n.triggerType === "time") {
    const f = n.triggerConfig?.frequency;
    const t = n.triggerConfig?.time || "??:??";
    if (f === "everyday") triggerText = `Ежедневно @ ${t}`;
    else if (f === "oneshot") triggerText = `Один раз @ ${t}`;
    else if (f === "specific") {
      const daysShort = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
      const days = (n.triggerConfig?.days || []).map(d => daysShort[d]).join(",");
      triggerText = `${days} @ ${t}`;
    }
    else if (f === "interval") triggerText = `Каждые ${n.triggerConfig?.interval} мин`;
    else if (f === "window") triggerText = `Каждые ${n.triggerConfig?.interval} мин с ${n.triggerConfig?.startTime} до ${n.triggerConfig?.endTime}`;
  } else if (n.triggerType === "consumption") {
    const mode = n.triggerConfig?.mode;
    if (mode === "item") triggerText = `При логировании: ${escapeHtml(n.triggerConfig?.itemName || "Любой")}`;
    else {
      const catMap = { 
        breakfast: "Завтрак", 
        lunch: "Обед", 
        dinner: "Ужин", 
        treat: "Вкусняшки", 
        snack: "Перекусы", 
        activity: "Занятия" 
      };
      triggerText = `При логировании: ${catMap[n.triggerConfig?.category] || "Любой"}`;
    }
  } else if (n.triggerType === "macro") {
    const metricMap = { water: "Вода", protein: "Белок", calories: "Калории", steps: "Шаги" };
    const cond = n.triggerConfig?.condition === "less" ? "<" : ">";
    triggerText = `${metricMap[n.triggerConfig?.metric]} ${cond} ${n.triggerConfig?.value} @ ${n.triggerConfig?.checkTime}`;
  } else if (n.triggerType === "idle") {
    triggerText = `Неактивность ${n.triggerConfig?.hours}ч (${n.triggerConfig?.startTime}-${n.triggerConfig?.endTime})`;
  }
  
  return `
    <div class="card" data-notification-id="${escapeHtml(n.id)}">
      <div class="mealCardHead">
        <div>
          <div style="font-weight:900">${escapeHtml(n.name)}</div>
          <div class="muted mealMeta">${escapeHtml(triggerText)}</div>
          <div class="muted mealMeta" style="font-style: italic;">"${escapeHtml(n.message)}"</div>
          <div class="muted mealMeta">След. срабатывание: ${escapeHtml(nextTime)}</div>
        </div>
      </div>
      <div class="mealCardActions">
        <label class="switch" style="margin-left: auto;">
          <input type="checkbox" data-notification-toggle="${escapeHtml(n.id)}" ${n.enabled ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </div>
    </div>
  `;
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("Ваш браузер не поддерживает уведомления.");
    return false;
  }

  if (Notification.permission === "granted") return true;

  if (Notification.permission !== "denied") {
    const permission = await Notification.requestPermission();
    if (permission === "granted") return true;
  }

  alert("Уведомления заблокированы в настройках браузера. Пожалуйста, разрешите их для работы этой функции.");
  return false;
}

function renderNotifications() {
  const root = document.getElementById("notificationsList");
  if (!root) return;
  
  const list = [...(window.notifications || [])].sort((a, b) => {
    // Enabled first, then by nextFiringTime
    if (a.enabled !== b.enabled) return b.enabled ? 1 : -1;
    if (!a.nextFiringTime) return 1;
    if (!b.nextFiringTime) return -1;
    return a.nextFiringTime - b.nextFiringTime;
  });

  if (!list.length) {
    root.innerHTML = `<div class="muted" style="text-align: center; padding: 20px;">У вас пока нет уведомлений.</div>`;
    return;
  }

  root.innerHTML = list.map(notificationCardHtml).join("");

  root.querySelectorAll("[data-notification-toggle]").forEach(toggle => {
    toggle.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-notification-toggle");
      toggleNotification(id, e.target.checked);
    });
  });
  
  installLongPress(root, "[data-notification-id]", el => {
    const id = el.getAttribute("data-notification-id");
    return window.notifications?.find(n => n.id === id);
  }, openNotificationEditModal);
}

async function saveNotification(notif) {
  if (!notif.id) notif.id = "notif_" + Date.now();
  notif.updatedAt = new Date().toISOString();
  
  if (notif.enabled) {
    const ok = await requestNotificationPermission();
    if (!ok) notif.enabled = false;
    notif.nextFiringTime = calculateNextFiringTime(notif);
  } else {
    notif.nextFiringTime = 0;
  }

  await txPut("notifications", notif);
  await loadNotifications();
  renderNotifications();
}

function getLastEntryTime() {
  const allEntries = [
    ...(window.todayMealEntries || []).map(e => new Date(e.createdAt).getTime()),
    ...(window.todayActivityEntries || []).map(e => new Date(e.createdAt).getTime())
  ];
  if (allEntries.length === 0) return 0;
  return Math.max(...allEntries);
}

function calculateNextFiringTime(n) {
  if (!n.enabled) return 0;
  const now = new Date();
  
  if (n.triggerType === "time") {
    const freq = n.triggerConfig?.frequency;
    
    if (freq === "oneshot" || freq === "everyday" || freq === "specific") {
      const [hh, mm] = (n.triggerConfig?.time || "09:00").split(":").map(Number);
      let target = new Date();
      target.setHours(hh, mm, 0, 0);
      
      if (freq === "oneshot") {
        return target.getTime() > now.getTime() ? target.getTime() : 0;
      }
      
      if (freq === "everyday") {
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }
      
      if (freq === "specific") {
        const allowedDays = n.triggerConfig?.days || []; // 1=Mon, 7=Sun
        if (allowedDays.length === 0) return 0;
        
        // Find next allowed day
        for (let i = 0; i < 8; i++) {
          let check = new Date(target.getTime());
          check.setDate(check.getDate() + i);
          let day = check.getDay(); // 0=Sun, 1=Mon
          let dayId = day === 0 ? 7 : day;
          
          if (allowedDays.includes(dayId)) {
            if (check.getTime() > now.getTime()) return check.getTime();
          }
        }
        return 0;
      }
    }

    if (freq === "interval" || freq === "window") {
      const minutes = n.triggerConfig?.interval || 60;
      let target = new Date(now.getTime() + minutes * 60000);
      
      if (freq === "window") {
        const [sh, sm] = (n.triggerConfig?.startTime || "09:00").split(":").map(Number);
        const [eh, em] = (n.triggerConfig?.endTime || "21:00").split(":").map(Number);
        
        const start = new Date(); start.setHours(sh, sm, 0, 0);
        const end = new Date(); end.setHours(eh, em, 0, 0);
        
        // If window ended today, jump to tomorrow's start
        if (now.getTime() >= end.getTime()) {
          start.setDate(start.getDate() + 1);
          return start.getTime();
        }
        // If currently before window, start at window opening
        if (now.getTime() < start.getTime()) {
          return start.getTime();
        }
        // If within window, ensure target doesn't overshoot window end
        if (target.getTime() > end.getTime()) {
          start.setDate(start.getDate() + 1);
          return start.getTime();
        }
      }
      return target.getTime();
    }
  }

  if (n.triggerType === "macro" || n.triggerType === "idle") {
    if (n.triggerType === "macro") {
      const [hh, mm] = (n.triggerConfig?.checkTime || "22:00").split(":").map(Number);
      let target = new Date();
      target.setHours(hh, mm, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
    if (n.triggerType === "idle") {
      const idleMs = (n.triggerConfig?.hours || 4) * 3600000;
      const [sh, sm] = (n.triggerConfig?.startTime || "10:00").split(":").map(Number);
      const [eh, em] = (n.triggerConfig?.endTime || "18:00").split(":").map(Number);
      
      let start = new Date(); start.setHours(sh, sm, 0, 0);
      let end = new Date(); end.setHours(eh, em, 0, 0);
      
      // If we are past today's window, look at tomorrow
      if (now.getTime() >= end.getTime()) {
        start.setDate(start.getDate() + 1);
        return start.getTime() + idleMs;
      }

      const lastEntry = getLastEntryTime();
      // Effective start is the later of (Window Start) or (Last Entry)
      const effectiveStart = Math.max(start.getTime(), lastEntry);
      const target = effectiveStart + idleMs;

      // If target is within current window and in the future, return it
      if (target > now.getTime() && target <= end.getTime()) {
        return target;
      }
      // If target passed end of window, next one is tomorrow
      if (target > end.getTime()) {
        start.setDate(start.getDate() + 1);
        return start.getTime() + idleMs;
      }
      // If target is in the past (user is already idle), fire "now" (plus small buffer)
      return now.getTime() + 1000;
    }
  }

  if (n.triggerType === "consumption") {
    return 0; // Consumption notifications trigger on event, not time
  }

  return 0;
}

async function rescheduleDynamicTriggers() {
  if (!window.notifications) return;
  let changed = false;
  for (const n of window.notifications) {
    if (!n.enabled) continue;
    if (n.triggerType === "idle" || n.triggerType === "macro") {
      const next = calculateNextFiringTime(n);
      if (next !== n.nextFiringTime) {
        n.nextFiringTime = next;
        await txPut("notifications", n);
        changed = true;
      }
    }
  }
  if (changed) renderNotifications();
}

function evaluateEventTriggers(type, itemId, category) {
  if (!window.notifications) return;
  
  try {
    window.notifications.forEach(n => {
      if (!n.enabled || n.triggerType !== "consumption") return;
      
      const config = n.triggerConfig;
      if (config.mode === "item") {
        if (config.itemId === itemId) fireNotification(n);
      } else if (config.mode === "category") {
        if (config.category === category) fireNotification(n);
      }
    });
  } catch (err) {
    console.error("evaluateEventTriggers failed", err);
  }
}

async function evaluateAllTriggers() {
  if (!window.notifications) return;
  const now = Date.now();
  
  try {
    for (const n of window.notifications) {
      if (!n.enabled || !n.nextFiringTime) continue;
      
      if (now >= n.nextFiringTime) {
        let shouldFire = true;
        
        if (n.triggerType === "macro") {
          let val = 0;
          if (n.triggerConfig.metric === "steps") {
            val = safeNum(document.getElementById("dashSteps")?.value);
          } else if (n.triggerConfig.metric === "water") {
            val = calcWaterTotalMl();
          } else if (n.triggerConfig.metric === "protein") {
            val = calcEatProteinG();
          } else if (n.triggerConfig.metric === "calories") {
            val = (window.todayMealEntries || []).reduce((acc, e) => acc + (e.mealSnapshot?.calories || 0) * (e.amount / 100), 0);
          }
          
          const target = n.triggerConfig.value;
          if (n.triggerConfig.condition === "less") shouldFire = val < target;
          else shouldFire = val > target;
        } else if (n.triggerType === "idle") {
          const lastEntry = getLastEntryTime();
          const idleMs = (n.triggerConfig.hours || 4) * 3600000;
          shouldFire = (now - lastEntry) >= idleMs;
        }

        if (shouldFire) {
          fireNotification(n);
          
          if (n.triggerConfig?.frequency === "oneshot") {
            n.enabled = false;
            n.nextFiringTime = 0;
          } else {
            n.nextFiringTime = calculateNextFiringTime(n);
          }
          await txPut("notifications", n);
        } else {
          n.nextFiringTime = calculateNextFiringTime(n);
          await txPut("notifications", n);
        }
      }
    }
    renderNotifications();
  } catch (err) {
    console.error("evaluateAllTriggers failed", err);
  }
}

async function fireNotification(n) {
  console.log("Firing notification:", n.name);
  
  // Add small delay to ensure previous modals (like classification) are fully closed
  setTimeout(async () => {
    const body = `<div>${escapeHtml(n.message)}</div>`;
    const onOk = async () => {
      // 1. Tell SW to close the system notification
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'DISMISS_NOTIFICATION',
          tag: n.id
        });
      }
      
      if (document.getElementById("secondaryModalBack").style.display === "block") {
        closeSecondaryModal();
      } else {
        closeModal();
      }
    };

    // 2. Show in-app modal
    if (document.body.classList.contains("modalOpen")) {
      openSecondaryModal(n.name, body, "OK", onOk, true);
    } else {
      openModal(n.name, body, "OK", false, onOk, null, null, null, true);
    }
  }, 200);

  // 3. Show system notification
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      reg.showNotification(n.name, {
        body: n.message,
        icon: "icon-192.png",
        tag: n.id,
        renotify: true
      });
    } else {
      new Notification(n.name, {
        body: n.message,
        icon: "icon-192.png",
        tag: n.id
      });
    }
  }
}

async function deleteNotification(id) {
  if (!id) return;
  await txDelete("notifications", id);
  await loadNotifications();
  renderNotifications();
}

async function loadNotifications() {
  window.notifications = await txGetAll("notifications");
}

async function toggleNotification(id, enabled) {
  const notif = window.notifications.find(n => n.id === id);
  if (!notif) return;

  notif.enabled = enabled; // Set state first!

  if (enabled) {
    const ok = await requestNotificationPermission();
    if (!ok) {
      notif.enabled = false;
      renderNotifications(); // Revert UI
      return;
    }
    notif.nextFiringTime = calculateNextFiringTime(notif);
  } else {
    notif.nextFiringTime = 0;
  }

  notif.updatedAt = new Date().toISOString();
  await txPut("notifications", notif);
  renderNotifications();
}

/**
 * Listens for messages from Service Worker (e.g. notification clicks)
 */
function wireSWMessages() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'NOTIFICATION_CLICKED') {
        const notif = window.notifications?.find(n => n.id === data.notificationId);
        if (notif) fireNotification(notif);
      }
    });
  }
}

function openNotificationEditModal(notif = null) {
  const isNew = !notif;
  const title = isNew ? "Новое уведомление" : "Изменить уведомление";
  
  const name = notif?.name || "";
  const message = notif?.message || "";
  const triggerType = notif?.triggerType || "time";
  
  const bodyHtml = `
    <div class="card">
      <div class="muted">Название</div>
      <input type="text" id="notifName" value="${escapeHtml(name)}" placeholder="Напр. Вода" style="width:100%; box-sizing:border-box">
      
      <div class="muted" style="margin-top:10px">Текст уведомления</div>
      <input type="text" id="notifMessage" value="${escapeHtml(message)}" placeholder="Напр. Пора выпить воды" style="width:100%; box-sizing:border-box">
      
      <div class="muted" style="margin-top:10px">Тип триггера</div>
      <select id="notifTriggerType" style="width:100%">
        <option value="time" ${triggerType === "time" ? "selected" : ""}>По времени</option>
        <option value="consumption" ${triggerType === "consumption" ? "selected" : ""}>При логировании</option>
        <option value="macro" ${triggerType === "macro" ? "selected" : ""}>Макро-цели / Шаги</option>
        <option value="idle" ${triggerType === "idle" ? "selected" : ""}>Неактивность</option>
      </select>
      
      <div id="notifTriggerConfig" style="margin-top:10px">
        <!-- Conditional fields will be injected here -->
      </div>
    </div>
  `;

  openModal(title, bodyHtml, "Сохранить", !isNew, async () => {
    const nameVal = document.getElementById("notifName").value.trim();
    const msgVal = document.getElementById("notifMessage").value.trim();
    const typeVal = document.getElementById("notifTriggerType").value;
    
    if (!nameVal) {
      alert("Введите название");
      return false; // Keep modal open
    }

    const newNotif = {
      ...notif,
      name: nameVal,
      message: msgVal,
      triggerType: typeVal,
      enabled: notif ? notif.enabled : true,
      triggerConfig: {}
    };

    if (typeVal === "time") {
      newNotif.triggerConfig = {
        time: document.getElementById("notifTime").value,
        frequency: document.getElementById("notifFreq").value
      };
      if (newNotif.triggerConfig.frequency === "specific") {
        const days = [];
        document.querySelectorAll("#notifDayPicker .day-btn.active").forEach(btn => {
          days.push(parseInt(btn.getAttribute("data-day")));
        });
        newNotif.triggerConfig.days = days;
      }
      if (newNotif.triggerConfig.frequency === "interval" || newNotif.triggerConfig.frequency === "window") {
        newNotif.triggerConfig.interval = parseInt(document.getElementById("notifInterval").value);
      }
      if (newNotif.triggerConfig.frequency === "window") {
        newNotif.triggerConfig.startTime = document.getElementById("notifStartTime").value;
        newNotif.triggerConfig.endTime = document.getElementById("notifEndTime").value;
      }
    } else if (typeVal === "consumption") {
      const mode = document.getElementById("notifConsumptionMode").value;
      newNotif.triggerConfig = {
        mode: mode
      };
      if (mode === "item") {
        newNotif.triggerConfig.itemId = document.getElementById("notifItemId").value;
        newNotif.triggerConfig.itemName = document.getElementById("notifSelectedItemName").textContent;
      } else {
        newNotif.triggerConfig.category = document.getElementById("notifCategory").value;
      }
    } else if (typeVal === "macro") {
      newNotif.triggerConfig = {
        metric: document.getElementById("notifMetric").value,
        condition: document.getElementById("notifCondition").value,
        value: parseFloat(document.getElementById("notifMetricValue").value),
        checkTime: document.getElementById("notifCheckTime").value
      };
    } else if (typeVal === "idle") {
      newNotif.triggerConfig = {
        hours: parseFloat(document.getElementById("notifIdleHours").value),
        startTime: document.getElementById("notifIdleStart").value,
        endTime: document.getElementById("notifIdleEnd").value
      };
    }

    await saveNotification(newNotif);
    // Success - return true (or nothing) to close
  }, async () => {
    await deleteNotification(notif.id);
    // wireModalButtons handles confirmation and closeModal
  });

  // Handle trigger type changes
  const typeSelect = document.getElementById("notifTriggerType");
  const configDiv = document.getElementById("notifTriggerConfig");

  const updateConfigUI = (type) => {
    if (type === "time") {
      const time = notif?.triggerConfig?.time || "09:00";
      const freq = notif?.triggerConfig?.frequency || "everyday";
      const days = notif?.triggerConfig?.days || [1,2,3,4,5,6,7]; // 1=Mon, 7=Sun
      const interval = notif?.triggerConfig?.interval || 60; // in minutes
      const startTime = notif?.triggerConfig?.startTime || "09:00";
      const endTime = notif?.triggerConfig?.endTime || "21:00";
      
      configDiv.innerHTML = `
        <div id="notifTimeCont" style="display: ${freq === "everyday" || freq === "oneshot" || freq === "specific" ? "block" : "none"}">
          <div class="muted">Время</div>
          <input type="time" id="notifTime" value="${escapeHtml(time)}" style="width:100%">
        </div>
        
        <div class="muted" style="margin-top:10px">Частота</div>
        <select id="notifFreq" style="width:100%">
          <option value="everyday" ${freq === "everyday" ? "selected" : ""}>Ежедневно</option>
          <option value="oneshot" ${freq === "oneshot" ? "selected" : ""}>Один раз</option>
          <option value="specific" ${freq === "specific" ? "selected" : ""}>Выбранные дни</option>
          <option value="interval" ${freq === "interval" ? "selected" : ""}>Интервал (каждые X мин)</option>
          <option value="window" ${freq === "window" ? "selected" : ""}>Интервал в окне</option>
        </select>
        
        <div id="notifIntervalCont" style="display: ${freq === "interval" || freq === "window" ? "block" : "none"}; margin-top:10px">
          <div class="muted">Интервал (минуты)</div>
          <input type="number" id="notifInterval" value="${interval}" min="1" step="1" style="width:100%">
        </div>

        <div id="notifWindowCont" style="display: ${freq === "window" ? "block" : "none"}; margin-top:10px">
          <div class="grid2">
            <div>
              <div class="muted">Начало</div>
              <input type="time" id="notifStartTime" value="${escapeHtml(startTime)}" style="width:100%">
            </div>
            <div>
              <div class="muted">Конец</div>
              <input type="time" id="notifEndTime" value="${escapeHtml(endTime)}" style="width:100%">
            </div>
          </div>
        </div>

        <div id="notifDayPickerCont" style="display: ${freq === "specific" ? "block" : "none"}">
          <div class="muted" style="margin-top:10px">Дни недели</div>
          <div class="day-picker" id="notifDayPicker">
            ${renderDayPicker(days)}
          </div>
        </div>
      `;
      
      const freqSelect = document.getElementById("notifFreq");
      const timeCont = document.getElementById("notifTimeCont");
      const intervalCont = document.getElementById("notifIntervalCont");
      const windowCont = document.getElementById("notifWindowCont");
      const dayCont = document.getElementById("notifDayPickerCont");

      freqSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        timeCont.style.display = (val === "everyday" || val === "oneshot" || val === "specific") ? "block" : "none";
        intervalCont.style.display = (val === "interval" || val === "window") ? "block" : "none";
        windowCont.style.display = val === "window" ? "block" : "none";
        dayCont.style.display = val === "specific" ? "block" : "none";
      });

      // Wire up day buttons
      document.getElementById("notifDayPicker").addEventListener("click", (e) => {
        const btn = e.target.closest(".day-btn");
        if (btn) btn.classList.toggle("active");
      });

    } else if (type === "consumption") {
      const mode = notif?.triggerConfig?.mode || "item"; // "item" or "category"
      const itemName = notif?.triggerConfig?.itemName || "";
      const itemId = notif?.triggerConfig?.itemId || "";
      const category = notif?.triggerConfig?.category || "breakfast";
      
      configDiv.innerHTML = `
        <div class="muted">Тип события</div>
        <select id="notifConsumptionMode" style="width:100%">
          <option value="item" ${mode === "item" ? "selected" : ""}>Конкретный элемент</option>
          <option value="category" ${mode === "category" ? "selected" : ""}>Любая категория</option>
        </select>

        <div id="notifItemPickerCont" style="display: ${mode === "item" ? "block" : "none"}; margin-top:10px">
          <div class="muted">Поиск блюда или активности</div>
          ${renderSearchInput("notifItemSearch", "Поиск...")}
          <div id="notifSearchResults" style="max-height: 150px; overflow-y: auto; margin-top: 5px; border: 1px solid #ddd; border-radius: 8px; display: none;">
            <!-- Search results will be injected here -->
          </div>
          <div id="notifSelectedItem" class="muted" style="margin-top: 5px; font-weight: 900; color: #19a34a;">
            Выбрано: <span id="notifSelectedItemName">${escapeHtml(itemName || "Ничего")}</span>
            <input type="hidden" id="notifItemId" value="${escapeHtml(itemId)}">
          </div>
        </div>

        <div id="notifCategoryPickerCont" style="display: ${mode === "category" ? "block" : "none"}; margin-top:10px">
          <div class="muted">Выберите категорию</div>
          <select id="notifCategory" style="width:100%">
            <option value="breakfast" ${category === "breakfast" ? "selected" : ""}>Завтрак</option>
            <option value="lunch" ${category === "lunch" ? "selected" : ""}>Обед</option>
            <option value="dinner" ${category === "dinner" ? "selected" : ""}>Ужин</option>
            <option value="treat" ${category === "treat" ? "selected" : ""}>Вкусняшки</option>
            <option value="snack" ${category === "snack" ? "selected" : ""}>Перекусы</option>
            <option value="activity" ${category === "activity" ? "selected" : ""}>Занятия</option>
          </select>
        </div>
      `;

      const modeSelect = document.getElementById("notifConsumptionMode");
      const itemCont = document.getElementById("notifItemPickerCont");
      const catCont = document.getElementById("notifCategoryPickerCont");
      
      modeSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        itemCont.style.display = val === "item" ? "block" : "none";
        catCont.style.display = val === "category" ? "block" : "none";
      });

      // Inline search logic
      const searchInput = document.getElementById("notifItemSearch");
      const resultsDiv = document.getElementById("notifSearchResults");
      const selectedNameSpan = document.getElementById("notifSelectedItemName");
      const selectedIdInput = document.getElementById("notifItemId");

      searchInput.addEventListener("focus", () => {
        searchInput.style.scrollMarginTop = "20px";
        searchInput.scrollIntoView({ behavior: "smooth", block: "start" });
      });

      searchInput.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase().trim();
        if (!query) {
          resultsDiv.style.display = "none";
          return;
        }

        const items = [
          ...(window.meals || []).map(m => ({ id: m.id, name: m.name, type: "meal" })),
          ...(window.activities || []).map(a => ({ id: a.id, name: a.name, type: "activity" }))
        ].filter(x => x.name.toLowerCase().includes(query)).slice(0, 20);

        if (items.length > 0) {
          resultsDiv.innerHTML = items.map(item => `
            <div class="search-result-item" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" 
                 style="padding: 8px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 14px;">
              ${escapeHtml(item.name)} <span class="muted" style="font-size: 11px;">(${item.type === "meal" ? "блюдо" : "активность"})</span>
            </div>
          `).join("");
          resultsDiv.style.display = "block";
        } else {
          resultsDiv.innerHTML = `<div class="muted" style="padding: 8px;">Ничего не найдено</div>`;
          resultsDiv.style.display = "block";
        }
      });

      resultsDiv.addEventListener("click", (e) => {
        const row = e.target.closest(".search-result-item");
        if (row) {
          const id = row.getAttribute("data-id");
          const name = row.getAttribute("data-name");
          selectedIdInput.value = id;
          selectedNameSpan.textContent = name;
          resultsDiv.style.display = "none";
          searchInput.value = "";
        }
      });
    } else if (type === "macro") {
      const metric = notif?.triggerConfig?.metric || "water";
      const condition = notif?.triggerConfig?.condition || "less";
      const value = notif?.triggerConfig?.value || 1000;
      const checkTime = notif?.triggerConfig?.checkTime || "14:00";

      configDiv.innerHTML = `
        <div class="muted">Показатель</div>
        <select id="notifMetric" style="width:100%">
          <option value="water" ${metric === "water" ? "selected" : ""}>Вода (мл)</option>
          <option value="protein" ${metric === "protein" ? "selected" : ""}>Белок (г)</option>
          <option value="calories" ${metric === "calories" ? "selected" : ""}>Калории (ккал)</option>
          <option value="steps" ${metric === "steps" ? "selected" : ""}>Шаги</option>
        </select>

        <div class="grid2" style="margin-top:10px">
          <div>
            <div class="muted">Условие</div>
            <select id="notifCondition" style="width:100%">
              <option value="less" ${condition === "less" ? "selected" : ""}>Меньше (<)</option>
              <option value="more" ${condition === "more" ? "selected" : ""}>Больше (>)</option>
            </select>
          </div>
          <div>
            <div class="muted">Значение</div>
            <input type="number" id="notifMetricValue" value="${value}" style="width:100%">
          </div>
        </div>

        <div class="muted" style="margin-top:10px">Время проверки</div>
        <input type="time" id="notifCheckTime" value="${escapeHtml(checkTime)}" style="width:100%">
        <div class="muted" style="font-size:11px; margin-top:4px">Уведомление сработает в это время, если условие выполнено.</div>
      `;
    } else if (type === "idle") {
      const hours = notif?.triggerConfig?.hours || 4;
      const start = notif?.triggerConfig?.startTime || "10:00";
      const end = notif?.triggerConfig?.endTime || "18:00";

      configDiv.innerHTML = `
        <div class="muted">Период неактивности (часы)</div>
        <input type="number" id="notifIdleHours" value="${hours}" min="1" step="0.5" style="width:100%">
        
        <div class="grid2" style="margin-top:10px">
          <div>
            <div class="muted">С</div>
            <input type="time" id="notifIdleStart" value="${escapeHtml(start)}" style="width:100%">
          </div>
          <div>
            <div class="muted">До</div>
            <input type="time" id="notifIdleEnd" value="${escapeHtml(end)}" style="width:100%">
          </div>
        </div>
        <div class="muted" style="font-size:11px; margin-top:4px">Сработает, если за указанное время не было записей в журнале.</div>
      `;
    }
  };

  typeSelect.addEventListener("change", (e) => updateConfigUI(e.target.value));
  updateConfigUI(triggerType);
}

function renderDayPicker(activeDays = []) {
  const days = [
    { id: 1, label: "П" },
    { id: 2, label: "В" },
    { id: 3, label: "С" },
    { id: 4, label: "Ч" },
    { id: 5, label: "П" },
    { id: 6, label: "С" },
    { id: 7, label: "В" }
  ];
  return days.map(d => `
    <div class="day-btn ${activeDays.includes(d.id) ? "active" : ""}" data-day="${d.id}">${d.label}</div>
  `).join("");
}

function mealCardHtml(m){
  const star = window.favoritesEnabled
    ? `<button class="btn secondary tiny" data-fav-meal="${escapeHtml(m.id)}" title="Избранное" style="padding:4px 8px">${m.favorite ? "★" : "☆"}</button>`
    : "";
  
  const displayAmount = m.portionG || m.defaultAmount || 100;
  const scaled = scaleMealNutrients(m, displayAmount);

  let metaHtml = "";
  if(m.short) metaHtml += `<div class="muted mealMeta">${escapeHtml(m.short)}</div>`;
  if(m.ingredients && typeof m.ingredients === "string") metaHtml += `<div class="muted mealMeta">${escapeHtml(m.ingredients)}</div>`;
  
  const b = scaled.proteinG > 0 ? `Б: ${Math.round(scaled.proteinG)} г` : "";
  const j = scaled.fluidMl > 0 ? `Ж: ${Math.round(scaled.fluidMl)} мл` : "";
  const sep = (b && j) ? " • " : "";
  
  if(b || j) metaHtml += `<div class="muted mealMeta">${b}${sep}${j}</div>`;
  
  const density = Math.round(m.calories);
  metaHtml += `<div class="muted mealMeta">${density} ккал / 100г</div>`;
  
  if(displayAmount !== 100) metaHtml += `<div class="muted mealMeta">Порция: ${displayAmount} г</div>`;

  const shareBtn = `<button class="btn secondary tiny" data-meal-share="${escapeHtml(m.id)}" title="Поделиться" style="padding:4px 8px">↗</button>`;

  return `
    <div class="card" data-meal-card="${escapeHtml(m.id)}">
      <div class="mealCardHead">
        <div>
          <div style="font-weight:900">${escapeHtml(m.name)}</div>
          ${metaHtml}
        </div>
        <div style="text-align:right">
          <div class="kcal">${Math.round(scaled.calories)}</div>
        </div>
      </div>
      <div class="mealCardActions">
        ${star}
        ${shareBtn}
        <button class="btn secondary tiny" data-meal-portion="${escapeHtml(m.id)}">Порция</button>
        <button class="btn tiny" data-meal-eat="${escapeHtml(m.id)}">Съесть</button>
      </div>
    </div>
  `;
}
function calculateCategoryTotals(cat) {
  const entries = (window.todayMealEntries || []).filter(e => {
    const m = mealFromEntry(e);
    return m && m.category === cat;
  });

  const totals = {
    calories: 0,
    protein: 0,
    fluid: 0,
    weight: 0
  };

  entries.forEach(e => {
    const m = mealFromEntry(e);
    totals.calories += safeNum(m?.calories);
    totals.protein += safeNum(m?.proteinG);
    totals.fluid += safeNum(m?.fluidMl);
    totals.weight += safeNum(e?.amount);
  });

  return totals;
}

function calculateOverallTotals() {
  const totals = {
    calories: 0,
    protein: 0,
    fluid: 0,
    weight: 0,
    burned: 0
  };

  (window.todayMealEntries || []).forEach(e => {
    const m = mealFromEntry(e);
    totals.calories += safeNum(m?.calories);
    totals.protein += safeNum(m?.proteinG);
    totals.fluid += safeNum(m?.fluidMl);
    totals.weight += safeNum(e?.amount);
  });

  (window.todayActivityEntries || []).forEach(e => {
    const a = activityFromEntry(e);
    totals.burned += Math.round(safeNum(a?.kcalPerHour) * safeNum(e?.minutes) / 60);
  });

  return totals;
}

function renderTodayByCategory(cat, todayListId){
  const root = document.getElementById(todayListId);
  if(!root) return;

  const entries = (window.todayMealEntries || []).filter(e => {
    const m = mealFromEntry(e);
    return m && m.category === cat;
  });

  if(!entries.length){
    root.innerHTML = `<div class="muted">Пока нет.</div>`;
    return;
  }

  const totals = calculateCategoryTotals(cat);
  const summaryHtml = `
    <div class="category-summary muted" style="font-size: 0.85em; margin-bottom: 4px; display: flex; gap: 12px; font-weight: 400;">
      <span>${Math.round(totals.calories)} ккал</span>
      <span>Б: ${Math.round(totals.protein)} г</span>
      <span>Ж: ${Math.round(totals.fluid)} мл</span>
      <span>${Math.round(totals.weight)} г</span>
    </div>
    <hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 8px;">
  `;

  root.innerHTML = summaryHtml + entries.map(e => {
    const m = mealFromEntry(e);
    const b = m.proteinG > 0 ? ` • Б ${Math.round(m.proteinG)} г` : "";
    const j = m.fluidMl > 0 ? ` • Ж ${Math.round(m.fluidMl)} мл` : "";
    return `
      <div class="itemRow">
        <div>
          <div style="font-weight:900">${escapeHtml(m?.name ?? "??")}</div>
          <div class="muted">${fmtTimeHM(e.createdAt) ? (fmtTimeHM(e.createdAt) + " • ") : ""}${Math.round(m?.calories ?? 0)} ккал${b}${j}</div>
        </div>
        <div>
          <button class="btn danger tiny" data-del-meal-entry="${escapeHtml(e.entryId)}">Удалить</button>
        </div>
      </div>
    `;
  }).join("");
}
function renderFoodAll(){
  const root = document.getElementById("foodList");
  if(!root) return;
  const list = sortMaybeFav((window.meals || []).filter(m => m.type === currentFoodType));
  if(!list.length){
    root.innerHTML = `<div class="card"><div style="font-weight:900">Пусто</div><div class="muted">Добавь элемент в эту категорию.</div></div>`;
    return;
  }
  root.innerHTML = list.map(mealCardHtml).join("");
}

function renderDayActivities(){
  const root = document.getElementById("dayActivitiesList");
  if(!root) return;

  if(!(window.todayActivityEntries || []).length){
    root.innerHTML = `<div class="muted">Пока нет.</div>`;
    return;
  }

  const totalMin = (window.todayActivityEntries || []).reduce((acc, e) => acc + safeNum(e.minutes), 0);
  const totalBurn = (window.todayActivityEntries || []).reduce((acc, e) => {
    const a = activityFromEntry(e);
    return acc + Math.round(safeNum(a?.kcalPerHour) * safeNum(e?.minutes) / 60);
  }, 0);

  const summaryHtml = `
    <div class="category-summary muted" style="font-size: 0.85em; margin-bottom: 4px; display: flex; gap: 12px; font-weight: 400;">
      <span>Всего: ${totalBurn} ккал</span>
      <span>Время: ${totalMin} мин</span>
    </div>
    <hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 8px;">
  `;

  root.innerHTML = summaryHtml + (window.todayActivityEntries || []).map((e, idx) => {
    const a = activityFromEntry(e);
    const burn = Math.round(safeNum(a?.kcalPerHour) * safeNum(e?.minutes) / 60);
    return `
      <div class="itemRow">
        <div>
          <div style="font-weight:900">${escapeHtml(a?.name ?? "??")}</div>
          <div class="muted">${fmtTimeHM(e.createdAt) ? (fmtTimeHM(e.createdAt) + " • ") : ""}${escapeHtml(e.minutes)} мин • ${burn} ккал</div>
        </div>
        <div>
          <button class="btn danger tiny" data-del-act-idx="${idx}">Удалить</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderDaySummary(){
  renderTodayByCategory("breakfast", "dayBreakfastList");
  renderTodayByCategory("lunch", "dayLunchList");
  renderTodayByCategory("dinner", "dayDinnerList");
  renderTodayByCategory("treat", "dayTreatList");
  renderTodayByCategory("snack", "daySnacksList");
  renderDayActivities();
  renderOverallSummary();
}

function renderOverallSummary() {
  const root = document.getElementById("dayOverallSummary");
  if(!root) return;

  const totals = calculateOverallTotals();
  
  root.innerHTML = `
    <div class="card" style="background: #f8fafc; border: 1px solid #e2e8f0; margin-bottom: 80px;">
      <div style="font-weight: 900; margin-bottom: 10px; font-size: 1.1em;">Итог дня</div>
      <div class="grid2" style="gap: 10px;">
        <div class="pill" style="background: white; padding: 10px; border: 1px solid #eee; display: flex; flex-direction: column; align-items: center;">
          <div class="muted" style="font-size: 0.8em;">Съедено</div>
          <div style="font-weight: 900; font-size: 1.2em;">${Math.round(totals.calories)} <span style="font-size: 0.7em; font-weight: 400;">ккал</span></div>
        </div>
        <div class="pill" style="background: white; padding: 10px; border: 1px solid #eee; display: flex; flex-direction: column; align-items: center;">
          <div class="muted" style="font-size: 0.8em;">Сожжено</div>
          <div style="font-weight: 900; font-size: 1.2em;">${Math.round(totals.burned)} <span style="font-size: 0.7em; font-weight: 400;">ккал</span></div>
        </div>
      </div>
      <div style="margin-top: 12px; display: flex; justify-content: space-between; font-size: 0.9em;" class="muted">
        <span>Б: <b>${Math.round(totals.protein)} г</b></span>
        <span>Ж: <b>${Math.round(totals.fluid)} мл</b></span>
        <span>Вес: <b>${Math.round(totals.weight)} г</b></span>
      </div>
    </div>
  `;
}

/* ---------- Activities ---------- */
function renderActivities(){
  const listEl = document.getElementById("activityList");
  const list = sortMaybeFav((window.activities || []).slice());
  if(!list.length){
    listEl.innerHTML = `<div class="card"><div style="font-weight:900">Пусто</div><div class="muted">Добавь активность.</div></div>`;
  } else {
    listEl.innerHTML = list.map(a => {
      const star = window.favoritesEnabled
        ? `<button class="btn secondary tiny" data-fav-act="${escapeHtml(a.id)}" title="Избранное" style="padding:4px 8px">${a.favorite ? "★" : "☆"}</button>`
        : "";
      return `
        <div class="card" data-act-card="${escapeHtml(a.id)}">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
            <div>
              <div style="font-weight:900">${escapeHtml(a.name)}</div>
              <div class="muted">${escapeHtml(a.kcalPerHour)} ккал/ч</div>
            </div>
            <div style="min-width: 240px">
              <div style="display:flex; gap:8px; justify-content:flex-end; align-items:center">
                ${star}
              </div>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:8px;">
                <input type="number" min="0" step="5" inputmode="numeric" placeholder="ккал" enterkeyhint="done" data-act-kcal="${escapeHtml(a.id)}">
                <input type="number" min="0" step="5" inputmode="numeric" placeholder="мин" enterkeyhint="done" data-act-min="${escapeHtml(a.id)}">
              </div>
              <button class="btn" style="width:100%; margin-top:8px" data-act-add="${escapeHtml(a.id)}">Добавить</button>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  const todayEl = document.getElementById("todayActivitiesList");
  if(todayEl){
    if(!(window.todayActivityEntries || []).length){
      todayEl.innerHTML = `<div class="muted">Пока нет.</div>`;
    } else {
      todayEl.innerHTML = (window.todayActivityEntries || []).map((e, idx) => {
        const a = activityFromEntry(e);
        const burn = Math.round(safeNum(a?.kcalPerHour) * safeNum(e?.minutes) / 60);
        return `
          <div class="itemRow">
            <div>
              <div style="font-weight:900">${escapeHtml(a?.name ?? "??")}</div>
              <div class="muted">${fmtTimeHM(e.createdAt) ? (fmtTimeHM(e.createdAt) + " • ") : ""}${escapeHtml(e.minutes)} мин • ${burn} ккал</div>
            </div>
            <div>
              <button class="btn danger tiny" data-del-act-idx="${idx}">Удалить</button>
            </div>
          </div>
        `;
      }).join("");
    }
  }
}

/* ---------- Modal ---------- */
let modalOnOk = null;
let modalOnDelete = null;
let modalOnExport = null;
let secondaryModalOnOk = null;
window.modalCurrentScore = 0;
window.recipeCurrentScore = 0;

function renderHeaderScore(score, containerId = "modalScoreContainer") {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  // If score is null/undefined, it means we are in a sub-modal or a modal that
  // doesn't have a rating (e.g. notifications). In this case, we hide the score 
  // container but we MUST NOT reset the global score because we might 
  // be preserving the score of a parent modal (e.g., Recipe Builder -> Add Ingredient).
  if (score === null || score === undefined) {
    container.innerHTML = "";
    return;
  }

  const val = safeNum(score);
  // Update the correct global state based on the container being used
  if (containerId === "recipeScoreContainer") {
    window.recipeCurrentScore = val;
  } else {
    window.modalCurrentScore = val;
  }

  const displayVal = val.toFixed(1);
  container.innerHTML = `${displayVal} ★`;
}

/**
 * Pushes a state to history when a modal opens, maintaining a stack of open modals.
 */
function pushModalState(modalId) {
  const currentState = history.state || { isRoot: true, tab: "day", modals: [] };
  const currentStack = [...(currentState.modals || [])];
  
  if (currentStack.length > 0 && currentStack[currentStack.length - 1] === modalId) {
    return; // Already at the top
  }

  if (!currentStack.includes(modalId)) {
    currentStack.push(modalId);
  }
  history.pushState({ ...currentState, modals: currentStack, isRoot: false }, "");
}
window.pushModalState = pushModalState;

function closeMoreMenu() {
  const menu = document.getElementById("moreMenu");
  if (menu && menu.style.display === "block") {
    // Hide UI immediately to avoid mismatch
    menu.style.display = "none";
    if (history.state && history.state.modals && history.state.modals.includes("moreMenu")) {
      history.back();
    } else {
      syncUI(history.state);
    }
  }
}
window.closeMoreMenu = closeMoreMenu;

// Global listener for Back button
window.addEventListener("popstate", (event) => {
  if (pendingTabSwitch) {
    const target = pendingTabSwitch;
    pendingTabSwitch = null;
    switchTab(target);
    return;
  }
  syncUI(event.state || { isRoot: true, tab: "day", modals: [] });
});

/**
 * Initializes the history state on first load.
 */
function initHistory() {
  if (!history.state || !history.state.isRoot) {
    history.replaceState({ isRoot: true, tab: "day", modals: [] }, "");
  }
}

/**
 * Syncs the UI with the provided modal stack and tab.
 */
function syncUI(state) {
  const active = state || { isRoot: true, tab: "day", modals: [] };
  const activeModals = active.modals || [];
  const activeTab = active.tab || "day";

  // 1. Sync Modals
  document.getElementById("modalBack").style.display = activeModals.includes("generalModal") ? "block" : "none";
  document.getElementById("secondaryModalBack").style.display = activeModals.includes("secondaryModal") ? "block" : "none";
  document.getElementById("portionModalBack").style.display = activeModals.includes("portionModal") ? "block" : "none";
  document.getElementById("recipeBuilderModalBack").style.display = activeModals.includes("recipeBuilder") ? "block" : "none";
  document.getElementById("classificationModalBack").style.display = activeModals.includes("classification") ? "block" : "none";
  if(!activeModals.includes("classification")) currentClassifyCallback = null;
  document.getElementById("shareModalBack").style.display = activeModals.includes("shareModalBack") ? "block" : "none";
  document.getElementById("importModalBack").style.display = activeModals.includes("importModalBack") ? "block" : "none";
  const menu = document.getElementById("moreMenu");
  if (menu) menu.style.display = activeModals.includes("moreMenu") ? "block" : "none";
  
  if (activeModals.length > 0) {
    document.body.classList.add("modalOpen");
  } else {
    document.body.classList.remove("modalOpen");
  }

  // 2. Sync Tab
  applyTabUI(activeTab);
}

/**
 * Updates the tab UI elements without pushing history.
 */
function applyTabUI(tabId) {
  let actualTabId = tabId;
  if (tabId === "more") actualTabId = "day"; 

  document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  
  const targetBtn = document.querySelector(`.tabbtn[data-tab="${actualTabId}"]`);
  if (targetBtn) targetBtn.classList.add("active");
  
  const content = document.getElementById(actualTabId);
  if (content) content.classList.add("active");

  document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
  const navItem = document.querySelector(`.nav-item[data-nav="${tabId}"]`);
  if (navItem) navItem.classList.add("active");

  const middleSlice = document.querySelector(".dash-middle");
  const bottomSlice = document.querySelector(".dash-bottom");
  const dashFieldsRow = document.getElementById("dashFieldsRow");
  
  const isMain = (tabId === "day" || tabId === "more");
  
  if(middleSlice) middleSlice.style.display = "block";
  if(bottomSlice) bottomSlice.style.display = "block";
  if(dashFieldsRow) dashFieldsRow.style.display = isMain ? "flex" : "none";

  // Trigger measureDash to ensure scroll logic has correct height after hiding fields
  if(window.measureDash) window.measureDash();

  // Toggle sticky control containers
  const foodSticky = document.getElementById("foodStickyControls");
  const actSticky = document.getElementById("activitiesStickyControls");
  
  if(foodSticky) foodSticky.style.display = (tabId === "food") ? "block" : "none";
  if(actSticky) actSticky.style.display = (tabId === "activities") ? "block" : "none";

  if(tabId === "food" && foodSticky){
    foodSticky.querySelectorAll(".food-sub-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.foodType === window.currentFoodType);
    });
  }

  const fab = document.getElementById("fab");
  if (fab) {
    if (tabId === "food" || tabId === "activities") {
      fab.style.display = "flex";
    } else {
      fab.style.display = "none";
    }
  }
}

/**
 * Switches tab and manages history state to ensure "Back" goes to Main.
 */
/**
 * Clears all search inputs and resets item visibility.
 */
function clearAllSearches(){
  ["foodSearch", "actSearch"].forEach(id => {
    const input = document.getElementById(id);
    if(input) {
      input.value = "";
      const clearBtn = document.getElementById(`${id}-clear`);
      if(clearBtn) clearBtn.classList.add("hidden");
    }
  });
  applySearchFilter("foodList", "");
  applySearchFilter("activityList", "");
}

function switchTab(tabId) {
  const state = history.state || { isRoot: true, tab: "day", modals: [] };
  const currentModals = state.modals || [];
  
  if (currentModals.length > 0) {
    pendingTabSwitch = tabId;
    history.go(-currentModals.length);
    return;
  }
  
  if (tabId === "day") {
    if (!state.isRoot) {
      history.back();
    }
    return;
  }

  if (state.isRoot) {
    history.pushState({ isRoot: false, tab: tabId, modals: [] }, "");
  } else if (state.tab !== tabId) {
    history.replaceState({ isRoot: false, tab: tabId, modals: [] }, "");
  }
  clearAllSearches();
  syncUI(history.state);
  
  // Reset scroll and dashboard state on tab switch
  if (typeof window.scrollTo === "function") {
    window.scrollTo(0, 0);
  }
}
window.switchTab = switchTab;

function openModal(title, bodyHtml, okText="OK", showDelete=false, onOk=null, onDelete=null, onExport=null, score = null, hideCancel = false){
  pushModalState("generalModal");

  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalOk").textContent = okText;
  
  const cancelBtn = document.getElementById("modalCancel");
  if (cancelBtn) cancelBtn.style.display = hideCancel ? "none" : "inline-block";

  renderHeaderScore(score);

  modalOnOk = onOk;
  modalOnDelete = onDelete;

  const delBtn = document.getElementById("modalDelete");
  delBtn.style.display = showDelete ? "inline-block" : "none";
  const expBtn = document.getElementById("modalExport");
  expBtn.style.display = onExport ? "inline-block" : "none";
  modalOnExport = onExport;

  document.body.classList.add("modalOpen");
  document.getElementById("modalBack").style.display = "block";
}
function openSecondaryModal(title, bodyHtml, okText="OK", onOk=null, hideCancel = false){
  pushModalState("secondaryModal");
  
  document.getElementById("secondaryModalTitle").textContent = title;
  document.getElementById("secondaryModalBody").innerHTML = bodyHtml;
  document.getElementById("secondaryModalOk").textContent = okText;
  
  const cancelBtn = document.getElementById("secondaryModalCancel");
  if (cancelBtn) cancelBtn.style.display = hideCancel ? "none" : "inline-block";
  
  secondaryModalOnOk = onOk;
  window.secondaryModalOnOk = onOk;
  
  document.body.classList.add("modalOpen");
  document.getElementById("secondaryModalBack").style.display = "block";
}

function closeSecondaryModal(){
  const back = document.getElementById("secondaryModalBack");
  if (back && back.style.display === "block") {
    back.style.display = "none";
    if (!document.querySelector('.modalBack[style*="display: block"]')) {
      document.body.classList.remove("modalOpen");
    }
    if (history.state && history.state.modals && history.state.modals.includes("secondaryModal")) {
      history.back();
    } else {
      document.getElementById("secondaryModalBody").innerHTML = "";
      secondaryModalOnOk = null;
      syncUI(history.state);
    }
  }
}

function closeModal(){
  const back = document.getElementById("modalBack");
  if (back && back.style.display === "block") {
    back.style.display = "none";
    document.body.classList.remove("modalOpen");
    if (history.state && history.state.modals && history.state.modals.includes("generalModal")) {
      history.back();
    } else {
      document.getElementById("modalBody").innerHTML = "";
      modalOnOk = null;
      modalOnDelete = null;
      modalOnExport = null;
      syncUI(history.state);
    }
  }
}
function showDatePicker(){
  const dp = document.getElementById("datePicker");
  if(!dp) return;
  try{ if(dp.showPicker) dp.showPicker(); else dp.click(); } catch { dp.click(); }
}

async function applyViewDate(newISO){
  const iso = String(newISO || "").trim();
  if(!iso) return;

  if(viewDateISO) await saveDraft();
  viewDateISO = iso;

  await refreshDateUI();
  await loadDraft();

  renderFoodAll();
  renderDaySummary();
  renderActivities();
  updateTopTotals();
}

function wireModalButtons(){
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  document.getElementById("modalBack").addEventListener("click", (e) => {
    if(e.target.id === "modalBack") closeModal();
  });
  document.getElementById("modalOk").addEventListener("click", async () => {
    if(!modalOnOk){ closeModal(); return; }
    const res = await modalOnOk();
    if(res !== false) closeModal();
  });
  document.getElementById("modalExport").addEventListener("click", async () => {
    if(!modalOnExport) return;
    await modalOnExport();
  });

  document.getElementById("modalDelete").addEventListener("click", async () => {
    if(!modalOnDelete) return;
    if(!confirm("Удалить?")) return;
    await modalOnDelete();
    closeModal();
  });

  // Secondary Modal Wiring
  document.getElementById("secondaryModalCancel")?.addEventListener("click", closeSecondaryModal);
  document.getElementById("secondaryModalBack")?.addEventListener("click", (e) => {
    if(e.target.id === "secondaryModalBack") closeSecondaryModal();
  });
  document.getElementById("secondaryModalOk")?.addEventListener("click", async () => {
    if(!secondaryModalOnOk){ closeSecondaryModal(); return; }
    const res = await secondaryModalOnOk();
    if(res !== false) closeSecondaryModal();
  });
}

function mealModalBody(meal){
  const cat = meal?.category ?? "snack";
  const type = meal?.type ?? "ingredient";
  const isRecipe = (type === "recipe");

  return `
    <div style="margin-top:10px">
      <div class="muted">Название</div>
      <div style="display:flex; gap:8px">
        <input id="mName" placeholder="Напр. яблоко" value="${escapeHtml(meal?.name ?? "")}" style="flex:1">
        <button class="btn secondary tiny" id="btnMSearchOFF" title="Поиск в интернете (OFF)" style="padding:0 12px">
          🔍
        </button>
      </div>
      <div id="mSearchStatus" class="muted" style="margin-top:4px; font-size:11px; display:none">Поиск...</div>
      <div id="mSearchResults" style="max-height:180px; overflow-y:auto; border:1px solid #eee; border-radius:8px; margin-top:4px; display:none"></div>
    </div>

    <div class="row2" style="margin-top:10px">
      <div>
        <div class="muted">Тип</div>
        <select id="mType" onchange="updateMealModalUI()">
          <option value="ingredient" ${type==="ingredient"?"selected":""}>Ингредиент</option>
          <option value="snack" ${type==="snack"?"selected":""}>${escapeHtml(window.labelSnackBank || "Вкусняшки")}</option>
          <option value="liquid" ${type==="liquid"?"selected":""}>Напиток</option>
        </select>
      </div>
      <div id="catWrapper" style="display:${isRecipe?'block':'none'}">
        <div class="muted">Категория (для сводки)</div>
        <select id="mCat">
          <option value="breakfast" ${cat==="breakfast"?"selected":""}>Завтрак</option>
          <option value="lunch" ${cat==="lunch"?"selected":""}>Обед</option>
          <option value="dinner" ${cat==="dinner"?"selected":""}>Ужин</option>
          <option value="treat" ${cat==="treat"?"selected":""}>Вкусняшки</option>
          <option value="snack" ${cat==="snack"?"selected":""}>${escapeHtml(window.labelSnackBank || "Вкусняшки")}</option>
        </select>
      </div>
    </div>

    <div class="grid2" style="margin-top:10px">
      <div>
        <div class="muted">Ккал / 100 г</div>
        <input id="mKcal100" type="number" min="0" step="1" placeholder="250" value="${escapeHtml(String(meal?.calories ?? ""))}">
      </div>
      <div>
        <div class="muted">ккал / порция</div>
        <input id="mKcalPortion" type="number" min="0" step="1" placeholder="0">
      </div>
    </div>

    <div class="grid2" style="margin-top:10px">
      <div>
        <div class="muted">Белок / 100 г</div>
        <input id="mProtein100" type="number" min="0" step="0.1" placeholder="0" value="${escapeHtml(String(meal?.proteinG ?? ""))}">
      </div>
      <div>
        <div class="muted">белок / порция</div>
        <input id="mProteinPortion" type="number" min="0" step="0.1" placeholder="0">
      </div>
    </div>

    <div class="row2" style="margin-top:10px">
      <div>
        <div class="muted">Жидкость / 100 г (мл)</div>
        <input id="mFluid100" type="number" min="0" step="1" placeholder="0" value="${escapeHtml(String(meal?.fluidMl ?? ""))}">
      </div>
      <div>
        <div class="muted">Вес порции (г)</div>
        <input id="mPortionG" type="number" min="1" step="1" placeholder="100" value="${escapeHtml(String(meal?.portionG ?? meal?.defaultAmount ?? ""))}">
      </div>
    </div>
    <div class="card" style="margin-top:15px; background:rgba(47,111,237,0.05); border:1px solid rgba(47,111,237,0.1)">
      <div style="font-weight:900; font-size:13px; color:#2f6fed">ПРЕВЬЮ ПОРЦИИ</div>
      <div class="row2" style="margin-top:8px">
        <div>
          <div class="muted" style="font-size:11px">Ккал (порция)</div>
          <div id="previewKcal" style="font-weight:900">0</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">Белок (порция)</div>
          <div id="previewProtein" style="font-weight:900">0</div>
        </div>
      </div>
    </div>

    <div style="margin-top:10px">
      <div class="muted">Коротко</div>
      <input id="mShort" placeholder="" value="${escapeHtml(meal?.short ?? "")}">
    </div>
  `;
}

window.updateMealModalUI = () => {
  const type = document.getElementById("mType")?.value;
  const catWrapper = document.getElementById("catWrapper");
  if(catWrapper) catWrapper.style.display = (type === "recipe") ? "block" : "none";
};

function renderSearchResults(results, root = document){
  const resultsDiv = root.querySelector("#mSearchResults");
  if(!resultsDiv) return;
  
  if(!results.length){
    resultsDiv.style.display = "block";
    resultsDiv.innerHTML = `<div class="muted" style="padding:10px; font-size:14px">Ничего не найдено.</div>`;
    return;
  }
  
  resultsDiv.style.display = "block";
  resultsDiv.innerHTML = results.map(r => {
    const isLocal = r.source === 'local';
    let badge = "";
    if (isLocal) {
      const isRecipe = r.type === 'recipe';
      const badgeText = isRecipe ? "Рец." : "Ингр.";
      const badgeBg = isRecipe ? "var(--accent)" : "#19a34a";
      badge = `<span class="badge" style="background:${badgeBg}">${badgeText}</span>`;
    } else {
      badge = `<span class="badge" style="background:#6b7280">OFF</span>`;
    }
      
    return `
      <div class="itemRow clickable" data-search-result-id="${escapeHtml(r.id)}" style="cursor:pointer; border-bottom:1px solid #f0f0f0">
        <div style="font-size:14px">
          ${badge}<b>${escapeHtml(r.name)}</b>
          <div class="muted" style="font-size:12px">${r.calories} ккал / 100г</div>
        </div>
      </div>
    `;
  }).join("");

  // Store results globally for click handling
  window.currentSearchResults = results;
}

async function handleSearchOFF(query, root = document){
  const status = root.querySelector("#mSearchStatus");
  const resultsDiv = root.querySelector("#mSearchResults");
  if(status) status.style.display = "block";
  if(resultsDiv) resultsDiv.style.display = "none";

  try {
    const results = await searchFood(query);
    window.currentSearchResults = results;
    renderSearchResults(results, root);
  } catch(err) {
    console.error(err);
    if(resultsDiv) resultsDiv.innerHTML = `<div class="muted" style="padding:10px">Ошибка поиска.</div>`;
  } finally {
    if(status) status.style.display = "none";
  }
}

function wireSearchUI(root = document){
  const nameInput = root.querySelector("#mName");
  const btnOFF = root.querySelector("#btnMSearchOFF");
  const resultsDiv = root.querySelector("#mSearchResults");
  
  if(!nameInput || !resultsDiv) return;

  const performLocalSearch = () => {
    const query = nameInput.value.trim();
    if (query.length < 2) {
      resultsDiv.style.display = "none";
      return;
    }
    
    // Search only local meals that are NOT recipes in this view
    const matches = (window.meals || []).filter(m => 
        m.name.toLowerCase().includes(query.toLowerCase()) && 
        m.type !== "recipe"
      )
      .map(m => ({
        id: m.id,
        name: m.name,
        calories: m.calories,
        proteinG: m.proteinG,
        source: 'local',
        unit: m.unit || 'г',
        defaultAmount: m.defaultAmount || 100
      }));

    if (matches.length > 0) {
      resultsDiv.style.display = "block";
      renderSearchResults(matches, root);
    } else {
      resultsDiv.style.display = "none";
    }
  };

  nameInput.addEventListener("input", performLocalSearch);
  
  btnOFF?.addEventListener("click", (e) => {
    e.preventDefault();
    resultsDiv.style.display = "block";
    handleSearchOFF(nameInput.value, root);
  });
  
  resultsDiv.addEventListener("click", (e) => {
    const row = e.target.closest("[data-search-result-id]");
    if(!row) return;
    const id = row.dataset.searchResultId;
    const item = window.meals.find(x => x.id === id) || (window.currentSearchResults || []).find(x => x.id === id);
    if(item){
      const nameInp = root.querySelector("#mName");
      const kcalInp = root.querySelector("#mKcal100");
      const protInp = root.querySelector("#mProtein100");
      const fluiInp = root.querySelector("#mFluid100");
      const portInp = root.querySelector("#mPortionG");
      
      if(nameInp) nameInp.value = item.name;
      if(kcalInp) kcalInp.value = item.calories;
      if(protInp) protInp.value = item.proteinG || 0;
      if(fluiInp) fluiInp.value = item.fluidMl || 0;
      if(portInp) portInp.value = item.defaultAmount || item.portionG || 100;
      
      // Trigger input events for preview
      [kcalInp, protInp, fluiInp, portInp].forEach(el => el?.dispatchEvent(new Event('input', { bubbles: true })));
      
      resultsDiv.style.display = "none";
    }
  });
}

window.renderSearchResults = renderSearchResults;

async function openQuickAddModal(){
  openModal(
    "Добавить",
    `
    <div class="grid2">
      <button class="btn" id="qaAddMeal" style="height:100px; font-size:18px">🍎 Еда</button>
      <button class="btn" id="qaAddActivity" style="height:100px; font-size:18px">🏃 Активность</button>
    </div>
    `,
    "Закрыть",
    false,
    null 
  );

  document.getElementById("qaAddMeal")?.addEventListener("click", () => {
    closeModal();
    openAddMealModal("snack");
  });
  document.getElementById("qaAddActivity")?.addEventListener("click", () => {
    closeModal();
    openAddActivityModal();
  });
}

async function openAddMealModal(defaultVal){
  let opts = {};
  if (typeof defaultVal === "object" && defaultVal !== null) {
    opts = { ...defaultVal };
  } else if (["ingredient", "recipe", "snack", "liquid"].includes(defaultVal)) {
    opts.type = defaultVal;
    if (defaultVal === "snack") opts.category = "snack";
  } else {
    opts.category = defaultVal;
  }

  openModal(
    "Добавить блюдо",
    mealModalBody(opts),
    "Добавить",
    false,
    async () => {
      const root = document.getElementById("modalBack");
      const mealData = getMealFromForm(root);
      if(!mealData){ setStatus("Название обязательно."); return false; }

      const meal = {
        ...mealData,
        id: uid("m"),
        favorite: false
      };

      await txPut("meals", meal);
      window.meals = await txGetAll("meals");
      renderFoodAll();
      renderDaySummary();
      updateTopTotals();
      setStatus("Добавлено.");
    },
    null,
    null,
    0
  );

  const root = document.getElementById("modalBack");
  wireSearchUI(root);
  installMealKcalAutocalc(root);
}
async function openEditMealModal(mealId){
  const meal = (window.meals || []).find(x => x.id === mealId);
  if(!meal) return;

  if(meal.type === "recipe"){
    openRecipeBuilder(mealId);
    return;
  }

  openModal(
    "Редактировать блюдо",
    mealModalBody(meal),
    "Сохранить",
    true,
        async () => {
          const root = document.getElementById("modalBack");
          const mealData = getMealFromForm(root);
          if(!mealData){ setStatus("Название обязательно."); return false; }
    
          const updated = {
            ...meal,
            ...mealData
          };
    
          await txPut("meals", updated);
          window.meals = await txGetAll("meals");
          await propagateRecipeUpdate(meal.id);
          window.meals = await txGetAll("meals"); // Refresh after propagation
          renderFoodAll();
          renderDaySummary();
          updateTopTotals();
          setStatus("Сохранено.");
        },
    async () => {
      await txDelete("meals", meal.id);
      window.meals = await txGetAll("meals");
      renderFoodAll();
      renderDaySummary();
      updateTopTotals();
      setStatus("Удалено.");
    },
    async () => {
      openShareModal(meal.id);
    },
    meal.usageScore
  );

  const root = document.getElementById("modalBack");
  wireSearchUI(root);
  installMealKcalAutocalc(root);
}

function getMealFromForm(root = document){
  const name = root.querySelector("#mName")?.value.trim();
  const k100 = Number(root.querySelector("#mKcal100")?.value || 0);
  const type = root.querySelector("#mType")?.value;
  if(!name) return null;

  const meal = {
    type,
    unit: "г",
    category: (type === "recipe") ? root.querySelector("#mCat")?.value : "snack",
    name,
    calories: Math.round(k100),
    proteinG: Number(root.querySelector("#mProtein100")?.value || 0),
    fluidMl: Number(root.querySelector("#mFluid100")?.value || 0),
    short: root.querySelector("#mShort")?.value.trim(),
    usageScore: parseFloat(safeNum(window.modalCurrentScore).toFixed(2)),
    updatedAt: new Date().toISOString()
  };

  let gVal = String(root.querySelector("#mPortionG")?.value ?? "").trim();
  const kp = Number(root.querySelector("#mKcalPortion")?.value || 0);

  if(!gVal){
    if(k100 > 0 && kp > 0){
      gVal = String(Math.round(kp * 100 / k100));
    } else if(k100 > 0){
      gVal = "100";
    }
  }

  if(gVal){
    const n = Number(gVal);
    if(Number.isFinite(n) && n > 0) {
      meal.portionG = Math.round(n);
      meal.defaultAmount = Math.round(n);
    }
  }
  if(!meal.defaultAmount) meal.defaultAmount = 100;

  return meal;
}

function installMealKcalAutocalc(root = document){
  const k100 = root.querySelector("#mKcal100");
  const p100 = root.querySelector("#mProtein100");
  const f100 = root.querySelector("#mFluid100");
  const portG = root.querySelector("#mPortionG");
  
  const kPortion = root.querySelector("#mKcalPortion");
  const pPortion = root.querySelector("#mProteinPortion");
  
  const previewK = root.querySelector("#previewKcal");
  const previewP = root.querySelector("#previewProtein");
  
  if(!k100 || !p100 || !f100 || !portG || !previewK || !previewP) return;

  const read = (el) => {
    const s = String(el.value ?? "").trim();
    if(!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };

  const updatePreview = () => {
    const valK = read(k100);
    const valP = read(p100);
    const weight = read(portG);

    if(weight > 0){
      const liveK = (kPortion && document.activeElement === kPortion) ? read(kPortion) : Math.round(valK * weight / 100);
      const liveP = (pPortion && document.activeElement === pPortion) ? read(pPortion) : Math.round(valP * weight / 100);

      previewK.textContent = liveK;
      previewP.textContent = liveP;
      
      // Also update the "per portion" input fields if they exist
      if(kPortion && document.activeElement !== kPortion && valK > 0) {
        kPortion.value = Math.round(valK * weight / 100);
      }
      if(pPortion && document.activeElement !== pPortion && valP > 0) {
        pPortion.value = Math.round(valP * weight / 100);
      }
    } else {
      previewK.textContent = (kPortion && document.activeElement === kPortion) ? read(kPortion) : "0";
      previewP.textContent = (pPortion && document.activeElement === pPortion) ? read(pPortion) : "0";
      
      // Don't erase per-portion fields if user is typing there or if density is missing
      if(kPortion && document.activeElement !== kPortion && valK > 0) kPortion.value = "";
      if(pPortion && document.activeElement !== pPortion && valP > 0) pPortion.value = "";
    }
  };

  [k100, p100, f100].forEach(el => {
    el.addEventListener("input", updatePreview);
    el.addEventListener("change", updatePreview);
  });

  portG.addEventListener("input", () => {
    updatePreview();
  });
  portG.addEventListener("change", () => {
    const weight = read(portG);
    if(weight > 0){
      // If density is 0 but portion total is set, calculate density
      if(read(k100) === 0 && read(kPortion) > 0){
        k100.value = Math.round(read(kPortion) * 100 / weight);
      }
      if(read(p100) === 0 && read(pPortion) > 0){
        p100.value = Math.round(read(pPortion) * 100 / weight);
      }
    }
    updatePreview();
  });

  if(kPortion){
    const handleKp = () => {
      const pk = read(kPortion);
      const weight = read(portG);
      const vk100 = read(k100);
      
      if(vk100 === 0 && weight > 0){
        k100.value = Math.round(pk * 100 / weight);
      } else if(vk100 > 0){
        portG.value = Math.round(pk * 100 / vk100);
      }
      updatePreview();
    };
    kPortion.addEventListener("input", updatePreview);
    kPortion.addEventListener("change", handleKp);
  }

  if(pPortion){
    const handlePp = () => {
      const pp = read(pPortion);
      const weight = read(portG);
      const vp100 = read(p100);
      
      if(vp100 === 0 && weight > 0){
        p100.value = Math.round(pp * 100 / weight);
      } else if(vp100 > 0){
        portG.value = Math.round(pp * 100 / vp100);
      }
      updatePreview();
    };
    pPortion.addEventListener("input", updatePreview);
    pPortion.addEventListener("change", handlePp);
  }
  
  updatePreview();
}

function activityModalBody(act){
  return `
    <div style="margin-top:10px">
      <div class="muted">Название</div>
      <input id="aName" placeholder="" value="${escapeHtml(act?.name ?? "")}">
    </div>
    <div style="margin-top:10px">
      <div class="muted">Ккал/час</div>
      <input id="aKph" type="number" min="1" step="10" placeholder="300" value="${escapeHtml(act?.kcalPerHour ?? "")}">
    </div>
  `;
}
async function openAddActivityModal(){
  openModal("Добавить активность", activityModalBody(null), "Сохранить", false, async () => {
    const name = document.getElementById("aName").value.trim();
    const kph = Number(document.getElementById("aKph").value);
    const usage = safeNum(window.modalCurrentScore);
    if(!name){ setStatus("Название обязательно."); return false; }
    if(!Number.isFinite(kph) || kph <= 0){ setStatus("Ккал/час должны быть > 0."); return false; }

    await txPut("activities", {
      id: uid("a"),
      name,
      kcalPerHour: Math.round(kph),
      favorite: false,
      usageScore: usage,
      updatedAt: new Date().toISOString()
    });

    window.activities = await txGetAll("activities");
    renderActivities();
    setStatus("Сохранено.");
  }, null, null, 0);
}
async function openEditActivityModal(actId){
  const act = (window.activities || []).find(x => x.id === actId);
  if(!act) return;

  openModal("Редактировать", activityModalBody(act), "Сохранить", true, async () => {
    const name = document.getElementById("aName").value.trim();
    const kph = Number(document.getElementById("aKph").value);
    const usage = safeNum(window.modalCurrentScore);
    if(!name){ setStatus("Название обязательно."); return false; }
    if(!Number.isFinite(kph) || kph <= 0){ setStatus("Ккал/час должны быть > 0."); return false; }

    const updated = {
      ...act,
      name,
      kcalPerHour: Math.round(kph),
      usageScore: usage,
      updatedAt: new Date().toISOString()
    };

    await txPut("activities", updated);
    window.activities = await txGetAll("activities");
    renderActivities();
    setStatus("Сохранено.");
  }, async () => {
    await txDelete("activities", act.id);
    window.activities = await txGetAll("activities");
    renderActivities();
    setStatus("Удалено.");
  }, null, act.usageScore);
}

function installLongPress(root, selector, getId, openEditor){
  let t = null;
  root?.addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(selector);
    if(!el) return;
    t = setTimeout(() => {
      const id = getId(el);
      openEditor(id);
    }, 650);
  });
  const cancel = () => { if(t){ clearTimeout(t); t = null; } };
  root?.addEventListener("pointerup", cancel);
  root?.addEventListener("pointercancel", cancel);
  root?.addEventListener("pointerleave", cancel);

  root?.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const el = ev.target.closest(selector);
    if(!el) return;
    const id = getId(el);
    openEditor(id);
  });
}

async function renderLogs(){
  const logs = await txGetAll("logs");
  logs.sort((a,b) => b.date.localeCompare(a.date));
  const el = document.getElementById("logList");
  if(!logs.length){ el.textContent = "Пока пусто."; return; }
  el.innerHTML = logs.slice(0,12).map(l => {
    const limit = (l.limitCalories ?? "");
    const rem = (l.remainingCalories ?? "");
    const goal = (l.goalKcal ?? "");
    return `
      <div style="margin:8px 0">
        <div><b>${escapeHtml(l.date)}</b> • ${escapeHtml(l.eatCalories ?? 0)} / ${escapeHtml(l.burnCalories ?? 0)} • нетто ${escapeHtml(l.netCalories ?? 0)}</div>
        <div class="muted">лимит: ${escapeHtml(limit)} • осталось: ${escapeHtml(rem)} • цель: ${escapeHtml(goal)} • вес: ${escapeHtml(l.weight ?? "-")} • шаги: ${escapeHtml(l.steps ?? "-")} ${l.autoSaved ? "• autoSaved" : ""}</div>
      </div>
    `;
  }).join("");
}

async function loadSettings(){
  renderNotifications();

  const h = await metaGet("settings.height");
  const a = await metaGet("settings.age");
  const sex = await metaGet("settings.sex");
  const bmrMult = await metaGet("settings.bmrMultiplier");
  const goalKcal = await metaGet("settings.goalKcal");
  const proteinPerKg = await metaGet("settings.proteinPerKg");
  const waterGoalMl = await metaGet("settings.waterGoalMl");

  let mode = await metaGet("settings.nettoMode");
  if(!mode){
    const oldMode = await metaGet("settings.nettoTileMode");
    const oldWithBmr = await metaGet("settings.nettoWithBmr");
    if(oldMode === "consumedLimit") mode = "consumedlimit";
    else if(oldMode === "remaining") mode = "remaining";
    else mode = oldWithBmr ? "nettowithbmr" : "nettonobmr";
    await metaSet("settings.nettoMode", mode);
  }

  const autoSave = await metaGet("settings.autoSaveOnNewDay");
  const favEnabled = await metaGet("settings.favoritesEnabled");
  const sortFreq = await metaGet("settings.sortFreqEnabled");
  const appTitle = await metaGet("settings.appTitle");
  const snackLabel = await metaGet("settings.labelSnackBank");

  document.getElementById("setHeight").value = h ?? 152;
  document.getElementById("setAge").value = a ?? 30;
  document.getElementById("setSex").value = sex ?? "female";

  const mult = (bmrMult === null || bmrMult === undefined || bmrMult === "") ? 1.2 : Number(bmrMult);
  document.getElementById("bmrMultiplier").value = Number.isFinite(mult) ? mult : 1.2;

  const goal = (goalKcal === null || goalKcal === undefined || goalKcal === "") ? -400 : Number(goalKcal);
  document.getElementById("goalKcal").value = Number.isFinite(goal) ? goal : -400;

  const ppk = (proteinPerKg === null || proteinPerKg === undefined || proteinPerKg === "") ? 0.83 : Number(proteinPerKg);
  document.getElementById("proteinPerKg").value = Number.isFinite(ppk) ? ppk : 0.83;

  const wGoal = (waterGoalMl === null || waterGoalMl === undefined || waterGoalMl === "") ? 2000 : Number(waterGoalMl);
  document.getElementById("waterGoalMl").value = (Number.isFinite(wGoal) && wGoal >= 0) ? Math.round(wGoal) : 2000;

  const okModes = ["nettonobmr","nettowithbmr","consumedlimit","remaining"];
  mode = okModes.includes(String(mode)) ? String(mode) : "nettonobmr";
  document.getElementById("nettoMode").value = mode;

  document.getElementById("autoSaveOnNewDay").checked = (autoSave === null) ? true : !!autoSave;
  document.getElementById("favoritesEnabled").checked = !!favEnabled;
  document.getElementById("sortFreqEnabled").checked = (sortFreq === null) ? true : !!sortFreq;

  document.getElementById("setAppTitle").value = appTitle ?? "";
  document.getElementById("appTitle").textContent = appTitle ?? "Food Plan";
  document.getElementById("labelSnackBank").value = snackLabel ?? "Вкусняшки";

  window.favoritesEnabled = !!favEnabled;
  window.sortFreqEnabled = (sortFreq === null) ? true : !!sortFreq;
  window.bmrMultiplier = Number.isFinite(mult) ? mult : 1.2;
  window.goalKcal = Number.isFinite(goal) ? goal : -400;
  window.proteinPerKg = Number(ppk) ? ppk : 0.83;
  window.waterGoalMl = (Number.isFinite(wGoal) && wGoal >= 0) ? Math.round(wGoal) : 2000;
  window.nettoMode = mode;
  window.autoSaveOnNewDay = (autoSave === null) ? true : !!autoSave;
  window.labelSnackBank = snackLabel ?? "Вкусняшки";

  const dbg = await metaGet("debug.enabled");
  document.getElementById("dbgEnabled").checked = !!dbg;

  themeTopToday = await metaGet("theme.topToday");
  themeTopPast = await metaGet("theme.topPast");
  themeDark = !!(await metaGet("theme.dark"));

  const elToday = document.getElementById("topColorToday");
  const elPast = document.getElementById("topColorPast");
  const elDark = document.getElementById("darkTheme");
  if(elToday) elToday.value = String(themeTopToday || "#2f6fed");
  if(elPast) elPast.value = String(themeTopPast || "#ec4899");
  if(elDark) elDark.checked = !!themeDark;

  applyTheme();
  updateDynamicLabels();
}
async function saveSettings(){
  const h = Number(document.getElementById("setHeight").value || 0);
  const a = Number(document.getElementById("setAge").value || 0);
  const sex = String(document.getElementById("setSex").value || "female");
  const bmrMult = Number(document.getElementById("bmrMultiplier").value || 1.2);
  const goal = Number(document.getElementById("goalKcal").value || -400);
  const proteinPerKg = Number(document.getElementById("proteinPerKg").value || 0.83);
  const waterGoalMl = Number(document.getElementById("waterGoalMl").value || 2000);
  const mode = String(document.getElementById("nettoMode").value || "nettonobmr");
  const autoSave = document.getElementById("autoSaveOnNewDay").checked;
  const favEnabled = document.getElementById("favoritesEnabled").checked;
  const sortFreq = document.getElementById("sortFreqEnabled").checked;
  const appTitle = document.getElementById("setAppTitle").value.trim();
  const snackLabel = document.getElementById("labelSnackBank").value.trim() || "Вкусняшки";

  const topToday = String(document.getElementById("topColorToday")?.value || "#2f6fed");
  const topPast = String(document.getElementById("topColorPast")?.value || "#ec4899");
  const dark = !!document.getElementById("darkTheme")?.checked;

  if(!h || !a){ setStatus("Рост и возраст обязательны."); return; }
  if(!Number.isFinite(bmrMult) || bmrMult < 1 || bmrMult > 2){ setStatus("BMR множитель: 1.00–2.00"); return; }
  if(!Number.isFinite(goal) || goal < -3000 || goal > 3000){ setStatus("Цель: -3000…3000"); return; }
  if(!Number.isFinite(proteinPerKg) || proteinPerKg < 0.2 || proteinPerKg > 3){ setStatus("Белок (г/кг): 0.20–3.00"); return; }
  if(!Number.isFinite(waterGoalMl) || waterGoalMl < 0 || waterGoalMl > 10000){ setStatus("Вода (мл): 0–10000"); return; }
  const okModes = ["nettonobmr","nettowithbmr","consumedlimit","remaining"];
  if(!okModes.includes(mode)){ setStatus("Неизвестный режим."); return; }

  await metaSet("settings.height", h);
  await metaSet("settings.age", a);
  await metaSet("settings.sex", sex);
  await metaSet("settings.bmrMultiplier", bmrMult);
  await metaSet("settings.goalKcal", goal);
  await metaSet("settings.proteinPerKg", proteinPerKg);
  await metaSet("settings.waterGoalMl", Math.round(waterGoalMl));
  await metaSet("settings.nettoMode", mode);
  await metaSet("settings.autoSaveOnNewDay", autoSave);
  await metaSet("settings.favoritesEnabled", favEnabled);
  await metaSet("settings.sortFreqEnabled", sortFreq);
  await metaSet("settings.appTitle", appTitle);
  await metaSet("settings.labelSnackBank", snackLabel);
  await metaSet("theme.topToday", topToday);
  await metaSet("theme.topPast", topPast);
  await metaSet("theme.dark", !!dark);

  themeTopToday = topToday;
  themeTopPast = topPast;
  themeDark = !!dark;
  applyTheme();

  document.getElementById("appTitle").textContent = appTitle || "Food Plan";

  window.favoritesEnabled = favEnabled;
  window.sortFreqEnabled = sortFreq;
  window.bmrMultiplier = bmrMult;
  window.goalKcal = goal;
  window.proteinPerKg = proteinPerKg;
  window.waterGoalMl = Math.round(waterGoalMl);
  window.nettoMode = mode;
  window.autoSaveOnNewDay = autoSave;
  window.labelSnackBank = snackLabel;

  renderFoodAll();
  renderActivities();
  updateTopTotals();
  updateDynamicLabels();
  setStatus("Настройки сохранены.");
}

async function loadShopping(){
  const rows = await txGetAll("shopping");
  document.getElementById("shopping").value = (rows.find(x => x.id === "main")?.text ?? "");
}
async function saveShopping(){
  await txPut("shopping", {id:"main", text: document.getElementById("shopping").value, updatedAt: new Date().toISOString()});
  setStatus("Сохранено.");
}

async function buildBackupObject(){
  return {
    schema: 17,
    exportedAt: new Date().toISOString(),
    meals: await txGetAll("meals"),
    activities: await txGetAll("activities"),
    logs: await txGetAll("logs"),
    shopping: await txGetAll("shopping"),
    meta: await txGetAll("meta")
  };
}
function downloadJson(filename, obj){
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function exportBackupNow(){
  const date = viewDateISO || await getAppDateISO();
  downloadJson(`backup-${date}.json`, await buildBackupObject());
  setStatus("Экспорт готов.");
}
async function importBackup(obj){
  if(!obj || ![1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17].includes(obj.schema)) throw new Error("Bad schema");
  await txClear("meals");
  await txClear("activities");
  await txClear("logs");
  await txClear("shopping");
  await txClear("meta");
  await txBulkPut("meals", obj.meals || []);
  await txBulkPut("activities", obj.activities || []);
  await txBulkPut("logs", obj.logs || []);
  await txBulkPut("shopping", obj.shopping || []);
  await txBulkPut("meta", obj.meta || []);
}

async function requestPersist(){
  try{
    if(navigator.storage?.persist){
      const ok = await navigator.storage.persist();
      setStatus(ok ? "Persistent storage включён." : "Persistent storage не включён.");
    } else setStatus("persist() не поддерживается.");
  }catch{
    setStatus("Ошибка persistent storage.");
  }
}

function seedActivitiesIfEmpty(arr){
  const generic = [
    { id: 'g-steps', name: 'Шаги (1000)', calories: 40, type: 'activity', usageScore: 0, favorite: false },
    { id: 'g-walking', name: 'Ходьба (30 мин)', calories: 120, type: 'activity', usageScore: 0, favorite: false },
    { id: 'g-running', name: 'Бег (30 мин)', calories: 300, type: 'activity', usageScore: 0, favorite: false },
    { id: 'g-cycling', name: 'Велосипед (30 мин)', calories: 200, type: 'activity', usageScore: 0, favorite: false },
    { id: 'g-swimming', name: 'Плавание (30 мин)', calories: 250, type: 'activity', usageScore: 0, favorite: false },
    { id: 'g-gym', name: 'Силовая (1 час)', calories: 250, type: 'activity', usageScore: 0, favorite: false }
  ];
  
  const existingIds = new Set(arr.map(m => m.id));
  const newItems = generic
    .filter(g => !existingIds.has(g.id))
    .map(m => ({...m, favorite: false, updatedAt: new Date().toISOString()}));
  
  return [...arr, ...newItems];
}

function seedNotificationsIfEmpty(arr) {
  if (arr.length > 0) return arr;

  const defaults = [
    {
      id: "def-water",
      name: "Водный баланс",
      message: "Пора выпить стакан воды!",
      enabled: true,
      triggerType: "time",
      triggerConfig: {
        frequency: "window",
        interval: 90,
        startTime: "09:00",
        endTime: "21:00"
      }
    },
    {
      id: "def-idle",
      name: "Забыли записать?",
      message: "Вы ничего не вводили уже 4 часа.",
      enabled: true,
      triggerType: "idle",
      triggerConfig: {
        hours: 4,
        startTime: "10:00",
        endTime: "18:00"
      }
    },
    {
      id: "def-steps",
      name: "Норма шагов",
      message: "Не забудьте ввести шаги за сегодня!",
      enabled: true,
      triggerType: "macro",
      triggerConfig: {
        metric: "steps",
        condition: "less",
        value: 1,
        checkTime: "22:00"
      }
    }
  ];

  return defaults.map(n => ({
    ...n,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
}

function addMealToToday(mealId, amount, customSnapshot, categoryOverride){
  const m = getMealById(mealId);
  const snap = customSnapshot || buildMealSnapshot(m);
  if(!snap) return;
  if(categoryOverride) snap.category = categoryOverride;
  window.todayMealEntries.push({
    entryId: uid("e"),
    mealId,
    mealSnapshot: snap,
    amount: amount || snap.portionG || 100,
    createdAt: new Date().toISOString()
  });
  rescheduleDynamicTriggers();
  setTimeout(() => evaluateEventTriggers("meal", mealId, snap.category), 100);
}

let currentPortionMealId = null;
let tempRecipeIngredients = []; // Local adjustments for the current modal session

function openPortionModal(mealId){
  pushModalState("portionModal");
  const meal = getMealById(mealId);
  if(!meal) return;
  currentPortionMealId = mealId;
  
  const toggleWrapper = document.getElementById("portionIngredientsToggleWrapper");
  const listRoot = document.getElementById("portionIngredientsList");
  const btnToggle = document.getElementById("btnTogglePortionIngredients");
  
  if(meal.type === "recipe" && meal.ingredients && meal.ingredients.length > 0){
    tempRecipeIngredients = JSON.parse(JSON.stringify(meal.ingredients));
    if(toggleWrapper) toggleWrapper.style.display = "block";
    if(listRoot) {
      listRoot.style.display = "none";
      if(btnToggle) btnToggle.textContent = "Показать ингредиенты";
    }
  } else {
    tempRecipeIngredients = [];
    if(toggleWrapper) toggleWrapper.style.display = "none";
    if(listRoot) listRoot.style.display = "none";
  }

  document.getElementById("portionItemName").textContent = meal.name;
  window.modalCurrentScore = safeNum(meal.usageScore);
  const amountInput = document.getElementById("portionAmount");
  const multInput = document.getElementById("portionMultiplier");

  let defaultAmt = meal.portionG || meal.defaultAmount;
  
  // If it's a recipe and we don't have a specific portionG (or it's 100 which is the generic default), 
  // try to calculate total from ingredients
  if((!defaultAmt || defaultAmt === 100) && meal.type === "recipe" && meal.ingredients){
    const totals = calculateRecipeTotals(meal.ingredients);
    const coeff = meal.weightCoefficient || 1.0;
    const calculated = Math.round(totals.weight * coeff);
    if(calculated > 0) defaultAmt = calculated;
  }
  if(!defaultAmt) defaultAmt = 100;
  
  amountInput.value = defaultAmt;
  multInput.value = 1;
  document.getElementById("portionUnit").textContent = meal.unit || "г";

  const confirmBtn = document.getElementById("confirmPortionBtn");
  if(confirmBtn) confirmBtn.textContent = (meal.type === "recipe") ? "Съесть" : "Добавить";
  
  updatePortionModalNutrients();
  
  document.body.classList.add("modalOpen");
  document.getElementById("portionModalBack").style.display = "block";
}

function updatePortionModalNutrients(source){
  const meal = getMealById(currentPortionMealId);
  if(!meal) return;
  
  const amountInput = document.getElementById("portionAmount");
  const multInput = document.getElementById("portionMultiplier");
  
  let defaultAmt = meal.portionG || meal.defaultAmount;
  if((!defaultAmt || defaultAmt === 100) && meal.type === "recipe" && meal.ingredients){
    const totals = calculateRecipeTotals(meal.ingredients);
    const coeff = meal.weightCoefficient || 1.0;
    const calculated = Math.round(totals.weight * coeff);
    if(calculated > 0) defaultAmt = calculated;
  }
  if(!defaultAmt) defaultAmt = 100;

  if(source === "mult"){
    const m = safeNum(multInput.value);
    const newTotal = Math.round(m * defaultAmt);
    amountInput.value = newTotal;
    
    if(tempRecipeIngredients.length > 0){
      tempRecipeIngredients.forEach((c, i) => {
        const base = (meal.ingredients[i]?.amount || 100);
        c.amount = Math.round(m * base);
      });
      renderPortionIngredients();
    }
  } else if(source === "amount"){
    const a = safeNum(amountInput.value);
    const m = (defaultAmt > 0) ? (a / defaultAmt) : 1;
    multInput.value = parseFloat(m.toFixed(2));
    
    if(tempRecipeIngredients.length > 0){
      tempRecipeIngredients.forEach((c, i) => {
        const base = (meal.ingredients[i]?.amount || 100);
        c.amount = Math.round(m * base);
      });
      renderPortionIngredients();
    }
  } else if(source === "ingredient"){
    // If one ingredient changed, recalculate total weight and update mult/amount
    const rawTotal = tempRecipeIngredients.reduce((sum, c) => sum + safeNum(c.amount), 0);
    const weightCoeff = meal.weightCoefficient || 1.0;
    const cookedTotal = Math.round(rawTotal * weightCoeff);
    
    amountInput.value = cookedTotal;
    multInput.value = (defaultAmt > 0) ? parseFloat((cookedTotal / defaultAmt).toFixed(2)) : 1;
  }
  
  // Final nutrient calculation based on either ingredients or the master scaling
  let scaled;
  if(tempRecipeIngredients.length > 0){
    const totals = calculateRecipeTotals(tempRecipeIngredients);
    const weightCoeff = meal.weightCoefficient || 1.0;
    const divisor = ((totals.weight * weightCoeff) || 100) / 100;
    
    scaled = {
      calories: Math.round(totals.calories / divisor) * (safeNum(amountInput.value) / 100),
      proteinG: (totals.proteinG / divisor) * (safeNum(amountInput.value) / 100),
      fluidMl: (totals.fluidMl / divisor) * (safeNum(amountInput.value) / 100)
    };
  } else {
    scaled = scaleMealNutrients(meal, safeNum(amountInput.value));
  }
  
  document.getElementById("portionKcal").textContent = Math.round(scaled.calories);
  document.getElementById("portionProtein").textContent = parseFloat(scaled.proteinG.toFixed(1));
  document.getElementById("portionFluid").textContent = parseFloat(scaled.fluidMl.toFixed(1));
}

function renderPortionIngredients(){
  const root = document.getElementById("portionIngredientsList");
  if(!root) return;
  
  const meal = getMealById(currentPortionMealId);
  
  root.innerHTML = tempRecipeIngredients.map((c, idx) => {
    const m = getMealById(c.mealId);
    const base = (meal.ingredients[idx]?.amount || 100);
    const mult = (base > 0) ? parseFloat((c.amount / base).toFixed(2)) : 1;
    
    return `
      <div class="card" style="padding:8px; margin:4px 0">
        <div class="muted" style="font-weight:900; margin-bottom:4px">${escapeHtml(m?.name || "??")}</div>
        <div style="display:flex; align-items:center; gap:8px">
          <div style="flex:1">
            <div class="muted" style="font-size:11px">Порции</div>
            <input type="number" step="0.1" value="${mult}" data-portion-ing-mult="${idx}" style="padding:4px; font-size:14px" inputmode="decimal" />
          </div>
          <div style="flex:1">
            <div class="muted" style="font-size:11px">${m?.unit || "г"}</div>
            <input type="number" step="1" value="${c.amount}" data-portion-ing-amt="${idx}" style="padding:4px; font-size:14px" inputmode="numeric" />
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function closePortionModal(){
  const back = document.getElementById("portionModalBack");
  if (back && back.style.display === "block") {
    back.style.display = "none";
    document.body.classList.remove("modalOpen");
    if (history.state && history.state.modals && history.state.modals.includes("portionModal")) {
      history.back();
    } else {
      syncUI(history.state);
    }
  }
}

function wirePortionModal(){
  document.getElementById("portionAmount")?.addEventListener("input", () => updatePortionModalNutrients("amount"));
  document.getElementById("portionMultiplier")?.addEventListener("input", () => updatePortionModalNutrients("mult"));
  
  document.getElementById("btnTogglePortionIngredients")?.addEventListener("click", () => {
    const listRoot = document.getElementById("portionIngredientsList");
    const btn = document.getElementById("btnTogglePortionIngredients");
    if(!listRoot) return;
    const isHidden = (listRoot.style.display === "none");
    listRoot.style.display = isHidden ? "block" : "none";
    btn.textContent = isHidden ? "Скрыть ингредиенты" : "Показать ингредиенты";
    if(isHidden) renderPortionIngredients();
  });
  
  document.getElementById("portionIngredientsList")?.addEventListener("input", (e) => {
    const amtIdx = e.target.dataset.portionIngAmt;
    const multIdx = e.target.dataset.portionIngMult;
    
    if(amtIdx !== undefined){
      const idx = parseInt(amtIdx, 10);
      const meal = getMealById(currentPortionMealId);
      const base = (meal.ingredients[idx]?.amount || 100);
      
      tempRecipeIngredients[idx].amount = safeNum(e.target.value);
      
      const card = e.target.closest(".card");
      const multInput = card.querySelector("[data-portion-ing-mult]");
      if(multInput && base > 0) multInput.value = parseFloat((tempRecipeIngredients[idx].amount / base).toFixed(2));
      
      updatePortionModalNutrients("ingredient", idx);
    }
    
    if(multIdx !== undefined){
      const idx = parseInt(multIdx, 10);
      const meal = getMealById(currentPortionMealId);
      const base = (meal.ingredients[idx]?.amount || 100);
      
      tempRecipeIngredients[idx].amount = Math.round(safeNum(e.target.value) * base);
      
      const card = e.target.closest(".card");
      const amtInput = card.querySelector("[data-portion-ing-amt]");
      if(amtInput) amtInput.value = tempRecipeIngredients[idx].amount;
      
      updatePortionModalNutrients("ingredient", idx);
    }
  });
  
  document.getElementById("cancelPortionBtn")?.addEventListener("click", closePortionModal);
  document.getElementById("portionModalBack")?.addEventListener("click", (e) => {
    if(e.target.id === "portionModalBack") closePortionModal();
  });
  
  document.getElementById("confirmPortionBtn")?.addEventListener("click", async () => {
    const meal = getMealById(currentPortionMealId);
    if(meal){
      const amountInput = document.getElementById("portionAmount");
      const finalAmount = safeNum(amountInput.value);
      
      const snap = buildMealSnapshot(meal);
      
      if(tempRecipeIngredients.length > 0){
        const totals = calculateRecipeTotals(tempRecipeIngredients);
        const weightCoeff = meal.weightCoefficient || 1.0;
        const divisor = ((totals.weight * weightCoeff) || 100) / 100;
        
        snap.calories = Math.round(totals.calories / divisor);
        snap.proteinG = totals.proteinG / divisor;
        snap.fluidMl = totals.fluidMl / divisor;
        // Important: we store the modified ingredients in the snapshot too
        snap.ingredients = JSON.parse(JSON.stringify(tempRecipeIngredients));
      }
      
      snap.portionG = finalAmount; 

      const finishAdd = (cat) => {
        snap.category = cat;
        const promise = incrementUsageScore(currentPortionMealId);
        addMealToToday(currentPortionMealId, finalAmount, snap);
        const finalize = async () => {
          await promise;
          await saveDraft();
          renderFoodAll();
          renderDaySummary();
          updateTopTotals();
          closePortionModal();
        };
        if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
          // In test mode, we might need a microtask to ensure addMealToToday has finished if it was async
          // but here it is sync. However, let's make sure we call all renderers.
          saveDraft(); renderFoodAll(); renderDaySummary(); updateTopTotals(); closePortionModal();
        } else {
          finalize();
        }
      };

      // Always show classification modal
      openClassificationModal(finishAdd);
    } else {
      closePortionModal();
    }
  });
}

let currentEditingRecipeId = null;

function openRecipeBuilder(mealId){
  pushModalState("recipeBuilder");
  currentEditingRecipeId = mealId || null;
  const meal = mealId ? getMealById(mealId) : null;

  window.recipeComponents = meal ? JSON.parse(JSON.stringify(meal.ingredients || [])) : [];
  document.getElementById("recipeName").value = meal ? meal.name : "";
  document.getElementById("recipeShort").value = meal ? (meal.short || "") : "";
  document.getElementById("recipePrep").value = meal ? (meal.prep || "") : "";
  
  renderHeaderScore(meal ? meal.usageScore : 0, "recipeScoreContainer");
  
  const delBtn = document.getElementById("btnRecipeDelete");
  if(delBtn) delBtn.style.display = mealId ? "inline-block" : "none";
  
  const shareBtn = document.getElementById("btnRecipeShare");
  if(shareBtn) shareBtn.style.display = mealId ? "inline-block" : "none";

  renderRecipeIngredients();
  
  const totals = calculateRecipeTotals(window.recipeComponents);
  document.getElementById("recipeCookedWeight").value = (meal && meal.portionG) ? meal.portionG : totals.weight;

  updateRecipeTotals();
  
  document.body.classList.add("modalOpen");
  document.getElementById("recipeBuilderModalBack").style.display = "block";
}

function closeRecipeBuilder(){
  const back = document.getElementById("recipeBuilderModalBack");
  if (back && back.style.display === "block") {
    back.style.display = "none";
    document.body.classList.remove("modalOpen");
    if (history.state && history.state.modals && history.state.modals.includes("recipeBuilder")) {
      history.back();
    } else {
      syncUI(history.state);
    }
  }
}

function renderRecipeIngredients(){
  const root = document.getElementById("recipeIngredientList");
  if(!root) return;
  
  if(!window.recipeComponents.length){
    root.innerHTML = `<div class="card muted">Нет ингредиентов. Нажми "+ Добавить", чтобы выбрать.</div>`;
    return;
  }
  
  root.innerHTML = window.recipeComponents.map((c, idx) => {
    const m = getMealById(c.mealId);
    const def = m?.defaultAmount || 100;
    const mult = (def > 0) ? parseFloat((c.amount / def).toFixed(2)) : 1;
    
    const isRecipe = m?.type === "recipe";
    const expandBtn = isRecipe ? `<button class="btn secondary tiny" data-recipe-expand="${idx}" style="margin-top:8px">Развернуть</button>` : "";
    const subList = isRecipe ? `<div id="recipeSubList-${idx}" style="display:none; margin-top:8px; border-left:2px solid #eee; padding-left:10px"></div>` : "";

    return `
      <div class="card" data-recipe-item-idx="${idx}">
        <div style="display:flex; justify-content:space-between; align-items:center">
          <div style="font-weight:900">${escapeHtml(m?.name || "??")}</div>
          <button class="btn danger tiny" data-recipe-del="${idx}">Удалить</button>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-top:8px">
          <div style="flex:1">
            <div class="muted">Порции</div>
            <input type="number" step="0.1" value="${mult}" data-recipe-mult="${idx}" inputmode="decimal" />
          </div>
          <div style="flex:1">
            <div class="muted">${m?.unit || "г"}</div>
            <input type="number" step="1" value="${c.amount}" data-recipe-amount="${idx}" inputmode="numeric" />
          </div>
        </div>
        ${expandBtn}
        ${subList}
      </div>
    `;
  }).join("");
}

function renderRecipeSubIngredients(parentIdx){
  const c = window.recipeComponents[parentIdx];
  const m = getMealById(c.mealId);
  const root = document.getElementById(`recipeSubList-${parentIdx}`);
  if(!root || !m || !m.ingredients) return;

  root.innerHTML = `<div class="muted" style="font-size:11px; margin-bottom:4px">Компоненты под-рецепта:</div>` + 
    m.ingredients.map((ing, subIdx) => {
      const subM = getMealById(ing.mealId);
      return `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
          <div style="flex:1; font-size:12px">${escapeHtml(subM?.name || "??")}</div>
          <input type="number" step="1" value="${ing.amount}" 
            data-sub-recipe-idx="${parentIdx}" 
            data-sub-ing-idx="${subIdx}" 
            style="width:70px; padding:4px; font-size:12px" />
          <div class="muted" style="font-size:11px">г</div>
        </div>
      `;
    }).join("");
}

function updateRecipeTotals(){
  const totals = calculateRecipeTotals(window.recipeComponents);
  document.getElementById("recipeTotalKcal").textContent = `${totals.calories} ккал`;
  document.getElementById("recipeTotalProtein").textContent = parseFloat(totals.proteinG.toFixed(1));
  document.getElementById("recipeTotalFluid").textContent = parseFloat(totals.fluidMl.toFixed(1));
  
  const rawW = Math.round(totals.weight);
  document.getElementById("recipeRawWeight").textContent = rawW;
  
  const cookedInput = document.getElementById("recipeCookedWeight");
  const cookedW = safeNum(cookedInput.value);
  
  const diffSpan = document.getElementById("recipeWeightDiff");
  if(rawW > 0 && cookedW > 0 && Math.abs(rawW - cookedW) > 0.1){
    const pct = Math.round(((cookedW - rawW) / rawW) * 100);
    const sign = pct > 0 ? "+" : "";
    diffSpan.textContent = `(${sign}${pct}%)`;
    diffSpan.style.color = pct < 0 ? "#dc2626" : "#19a34a";
  } else {
    diffSpan.textContent = "";
  }
}

async function handleRecipeEatNow(){
  const name = document.getElementById("recipeName").value.trim() || "Новый рецепт";
  const totals = calculateRecipeTotals(window.recipeComponents);
  const cookedWeight = safeNum(document.getElementById("recipeCookedWeight").value) || totals.weight || 100;
  
  if(!window.recipeComponents.length){
    setStatus("Добавь ингредиенты.");
    return;
  }

  const divisor = cookedWeight / 100;

  openClassificationModal((selectedCat) => {
    const snap = {
      id: uid("temp"),
      category: selectedCat,
      name,
      calories: Math.round(totals.calories / divisor),
      proteinG: parseFloat((totals.proteinG / divisor).toFixed(1)),
      fluidMl: parseFloat((totals.fluidMl / divisor).toFixed(1)),
      portionG: cookedWeight,
      ingredients: JSON.parse(JSON.stringify(window.recipeComponents)),
      isTemporary: true
    };
    
    addMealToToday(null, cookedWeight, snap);
    
    const finalize = async () => {
      await saveDraft();
      renderDaySummary();
      updateTopTotals();
      closeRecipeBuilder();
      setStatus("Добавлено в лог (разово).");
    };

    if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
      saveDraft(); renderDaySummary(); updateTopTotals(); closeRecipeBuilder(); setStatus("Добавлено в лог (разово).");
    } else {
      finalize();
    }
  });
}

async function handleRecipeSave(){
  const name = document.getElementById("recipeName").value.trim() || "Новый рецепт";
  const totals = calculateRecipeTotals(window.recipeComponents);
  const cookedWeight = safeNum(document.getElementById("recipeCookedWeight").value) || totals.weight || 100;
  
  // Density = Total / (CookedWeight / 100)
  const divisor = cookedWeight / 100;
  const kcal100 = Math.round(totals.calories / divisor);
  const prot100 = parseFloat((totals.proteinG / divisor).toFixed(1));
  const fluid100 = parseFloat((totals.fluidMl / divisor).toFixed(1));
  
  const weightCoeff = totals.weight > 0 ? (cookedWeight / totals.weight) : 1.0;

  const updatedMeal = {
    id: currentEditingRecipeId || uid("m"),
    type: "recipe",
    category: "lunch", 
    unit: "г",
    defaultAmount: 100, // Default to 100g for recipes
    name,
    short: document.getElementById("recipeShort").value.trim(),
    prep: document.getElementById("recipePrep").value.trim(),
    calories: kcal100,
    proteinG: prot100,
    fluidMl: fluid100,
    portionG: cookedWeight,
    weightCoefficient: weightCoeff,
    usageScore: parseFloat(safeNum(window.recipeCurrentScore).toFixed(2)),
    ingredients: JSON.parse(JSON.stringify(window.recipeComponents)),
    updatedAt: new Date().toISOString()
  };
  
  await txPut("meals", updatedMeal);
  
  if(currentEditingRecipeId){
    const idx = window.meals.findIndex(m => m.id === currentEditingRecipeId);
    if(idx !== -1) window.meals[idx] = updatedMeal;
    // Propagate changes to parents
    await propagateRecipeUpdate(currentEditingRecipeId);
  } else {
    window.meals.push(updatedMeal);
  }

  renderFoodAll();
  closeRecipeBuilder();
  setStatus(currentEditingRecipeId ? "Рецепт обновлен." : "Сохранено как блюдо.");
}

async function handleRecipeDelete(){
  if(!currentEditingRecipeId) return;
  if(!confirm("Удалить этот рецепт?")) return;
  
  const deletedId = currentEditingRecipeId;
  await txDelete("meals", deletedId);
  const idx = window.meals.findIndex(m => m.id === deletedId);
  if(idx !== -1) window.meals.splice(idx, 1);
  
  // Propagate to parents (they will now see this ingredient as missing/0)
  await propagateRecipeUpdate(deletedId);

  renderFoodAll();
  closeRecipeBuilder();
  setStatus("Рецепт удален.");
}

let currentClassifyCallback = null;

function openClassificationModal(callback){
  pushModalState("classification");
  currentClassifyCallback = callback;
  document.body.classList.add("modalOpen");
  document.getElementById("classificationModalBack").style.display = "block";
}

function closeClassificationModal(){
  const back = document.getElementById("classificationModalBack");
  if (back && back.style.display === "block") {
    back.style.display = "none";
    document.body.classList.remove("modalOpen");
    if (history.state && history.state.modals && history.state.modals.includes("classification")) {
      history.back();
    } else {
      syncUI(history.state);
    }
  }
}

function wireClassificationModal(){
  document.querySelectorAll(".btn-classify").forEach(btn => {
    btn.addEventListener("click", () => {
      const category = btn.dataset.classify;
      if(category && currentClassifyCallback){
        currentClassifyCallback(category);
        currentClassifyCallback = null;
        closeClassificationModal();
      }
    });
  });
  document.getElementById("cancelClassifyBtn")?.addEventListener("click", () => {
    currentClassifyCallback = null;
    closeClassificationModal();
  });
  document.getElementById("classificationModalBack")?.addEventListener("click", (e) => {
    if(e.target.id === "classificationModalBack"){
      currentClassifyCallback = null;
      closeClassificationModal();
    }
  });
}

function wireRecipeBuilder(){
  document.getElementById("btnRecipeDelete")?.addEventListener("click", handleRecipeDelete);
    document.getElementById("recipeCookedWeight")?.addEventListener("input", updateRecipeTotals);
    
    document.getElementById("recipeIngredientList")?.addEventListener("click", (e) => {
      const expandIdx = e.target.dataset.recipeExpand;
      if(expandIdx !== undefined){
        const idx = parseInt(expandIdx, 10);
        const subList = document.getElementById(`recipeSubList-${idx}`);
        if(subList){
          const isHidden = subList.style.display === "none";
          subList.style.display = isHidden ? "block" : "none";
          e.target.textContent = isHidden ? "Скрыть" : "Развернуть";
          if(isHidden) renderRecipeSubIngredients(idx);
        }
          }
        });
      
        document.getElementById("recipeIngredientList")?.addEventListener("input", async (e) => {
          const subParentIdx = e.target.dataset.subRecipeIdx;
          const subIngIdx = e.target.dataset.subIngIdx;
      
          if(subParentIdx !== undefined && subIngIdx !== undefined){
            const pIdx = parseInt(subParentIdx, 10);
            const sIdx = parseInt(subIngIdx, 10);
            const parentComp = window.recipeComponents[pIdx];
            const subRecipe = getMealById(parentComp.mealId);
            
            if(subRecipe && subRecipe.ingredients){
              // 1. Update sub-recipe data
              subRecipe.ingredients[sIdx].amount = safeNum(e.target.value);
              
              // 2. Recalculate sub-recipe totals
              const totals = calculateRecipeTotals(subRecipe.ingredients);
              const weightCoeff = subRecipe.weightCoefficient || 1.0;
              const cookedW = totals.weight * weightCoeff;
              const divisor = (cookedW || 100) / 100;
      
              subRecipe.calories = Math.round(totals.calories / divisor);
              subRecipe.proteinG = Math.round(totals.proteinG / divisor);
              subRecipe.fluidMl = Math.round(totals.fluidMl / divisor);
              subRecipe.portionG = cookedW;
              subRecipe.updatedAt = new Date().toISOString();
      
              // 3. Global Sync
              await txPut("meals", subRecipe);
              
              // 4. Update the parent view totals (current builder)
              updateRecipeTotals();
              
              // 5. Propagate to other possible parents in DB
              await propagateRecipeUpdate(subRecipe.id);
            }
          }
        });
      
        document.getElementById("btnAddIngredient")?.addEventListener("click", () => {    const list = window.meals.filter(m => m.type === "ingredient" || m.type === "snack" || m.type === "liquid" || m.type === "recipe");
    
    const body = `
      <div class="card" style="margin-bottom:10px">
        <div class="muted">Выбери или найди в базе</div>
        <div style="display:flex; gap:8px">
          <input id="selIngSearch" placeholder="Начни вводить название..." style="flex:1" />
        </div>
        <div id="selIngResults" style="max-height:150px; overflow-y:auto; border:1px solid #eee; border-radius:8px; margin-top:4px; display:none"></div>
      </div>

      <div class="card">
        <div class="muted">Ингредиент</div>
        <select id="selIng">
          ${list.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (${m.calories} ккал/100г)</option>`).join("")}
        </select>
        <div style="display:flex; align-items:center; gap:10px; margin-top:10px">
          <div style="flex:1">
            <div class="muted">Кол-во порций</div>
            <input id="selIngMult" type="number" step="0.1" value="1" inputmode="decimal" />
          </div>
          <div style="flex:1">
            <div class="muted">Количество (<span id="selIngUnitDisplay">г</span>)</div>
            <input id="selIngAmt" type="number" step="1" value="100" />
          </div>
        </div>
      </div>
    `;
    
    openModal("Добавить в рецепт", body, "Добавить", false, () => {
      const mealId = document.getElementById("selIng").value;
      const amount = safeNum(document.getElementById("selIngAmt").value);
      if(mealId && amount > 0){
        window.recipeComponents.push({ mealId, amount });
        renderRecipeIngredients();
        updateRecipeTotals();
      }
    });

    const sel = document.getElementById("selIng");
    const amt = document.getElementById("selIngAmt");
    const mult = document.getElementById("selIngMult");
    const unt = document.getElementById("selIngUnitDisplay");
    const searchInput = document.getElementById("selIngSearch");
    const resultsDiv = document.getElementById("selIngResults");

    // Initialize unit
    if(list.length > 0) {
      const first = list.find(x => x.id === sel.value);
      if(first) unt.textContent = first.unit || "г";
    }

    const sync = (source) => {
      const m = window.meals.find(x => x.id === sel.value);
      if(!m) return;
      const def = m.defaultAmount || 100;
      if(source === "mult"){
        amt.value = Math.round(safeNum(mult.value) * def);
      } else if(source === "amt"){
        mult.value = (def > 0) ? parseFloat((safeNum(amt.value) / def).toFixed(2)) : 1;
      } else if(source === "sel"){
        amt.value = def;
        mult.value = 1;
        if(unt) unt.textContent = m.unit || "г";
      }
    };

    searchInput?.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      const rawQ = searchInput.value.trim();
      if(q.length < 1) { resultsDiv.style.display = "none"; return; }
      
      const filtered = list.filter(m => m.name.toLowerCase().includes(q)).slice(0, 10);
      resultsDiv.style.display = "block";

      let html = filtered.map(m => {
        const isRecipe = m.type === "recipe";
        const badgeText = isRecipe ? "Рец." : "Ингр.";
        const badgeColor = isRecipe ? "var(--accent)" : "#19a34a";
        const isLoop = isRecipe && detectRecipeLoop(m.id, currentEditingRecipeId);
        const opacity = isLoop ? "0.5" : "1";
        const cursor = isLoop ? "not-allowed" : "pointer";
        const grayscale = isLoop ? "filter: grayscale(1);" : "";
        
        return `
          <div class="itemRow clickable" data-ing-id="${escapeHtml(m.id)}" data-loop="${isLoop}" style="padding:6px; cursor:${cursor}; border-bottom:1px solid #eee; font-size:13px; opacity:${opacity}; ${grayscale}">
            <span class="badge" style="background:${badgeColor}">${badgeText}</span>
            <b>${escapeHtml(m.name)}</b> (${m.calories} ккал)
          </div>
        `;
      }).join("");

      // Always append "Add New" button
      html += `
        <div style="padding:10px; text-align:center; border-top:1px solid #eee">
          ${filtered.length === 0 ? '<div class="muted" style="margin-bottom:8px">Ничего не найдено.</div>' : ''}
          <button class="btn secondary tiny" id="btnAddNewIng" style="width:100%">+ Добавить: "${escapeHtml(rawQ)}"</button>
        </div>
      `;
      
      resultsDiv.innerHTML = html;

      document.getElementById("btnAddNewIng")?.addEventListener("click", () => {
        openSecondaryModal("Добавить блюдо", mealModalBody({type: "ingredient", name: rawQ}), "Добавить", async () => {
          const secBack = document.getElementById("secondaryModalBack");
          const mealData = getMealFromForm(secBack);
          if(!mealData){ setStatus("Название обязательно."); return false; }

          const newMeal = {
            ...mealData,
            id: uid("m"),
            favorite: false
          };

          await txPut("meals", newMeal);
          window.meals.push(newMeal);
          list.push(newMeal); // Update the local closure list for search
          renderFoodAll();

          // Auto-select in the parent modal
          const opt = document.createElement("option");
          opt.value = newMeal.id;
          opt.textContent = `${newMeal.name} (${newMeal.calories} ккал)`;
          sel.appendChild(opt);
          sel.value = newMeal.id;
          sync("sel");
          resultsDiv.style.display = "none";
          searchInput.value = "";
          return true; 
        });
        const secRoot = document.getElementById("secondaryModalBack");
        wireSearchUI(secRoot);
        installMealKcalAutocalc(secRoot);
      });
    });

    resultsDiv?.addEventListener("click", async (e) => {
      const row = e.target.closest("[data-ing-id]");
      if(!row) return;
      
      const isLoop = row.dataset.loop === "true";
      if(isLoop){
        alert("Невозможно добавить этот рецепт, так как он уже используется в текущей цепочке ингредиентов (циклическая зависимость).");
        return;
      }

      const finalId = row.dataset.ingId; 

      // Update select and sync
      const opt = document.createElement("option");
      opt.value = finalId;
      const m = window.meals.find(x => x.id === finalId);
      opt.textContent = `${m.name} (${m.calories} ккал)`;
      sel.appendChild(opt);
      sel.value = finalId;
      sync("sel");
      resultsDiv.style.display = "none";
      searchInput.value = "";
    });

    sel?.addEventListener("change", () => sync("sel"));
    amt?.addEventListener("input", () => sync("amt"));
    mult?.addEventListener("input", () => sync("mult"));
  });
  
  document.getElementById("recipeIngredientList")?.addEventListener("input", (e) => {
    const amtIdx = e.target.dataset.recipeAmount;
    const multIdx = e.target.dataset.recipeMult;
    
    if(amtIdx !== undefined){
      const idx = parseInt(amtIdx, 10);
      const m = getMealById(window.recipeComponents[idx].mealId);
      const def = m?.defaultAmount || 100;
      window.recipeComponents[idx].amount = safeNum(e.target.value);
      const card = e.target.closest(".card");
      const multInput = card.querySelector("[data-recipe-mult]");
      if(multInput && def > 0) multInput.value = parseFloat((window.recipeComponents[idx].amount / def).toFixed(2));
      updateRecipeTotals();
    }
    
    if(multIdx !== undefined){
      const idx = parseInt(multIdx, 10);
      const m = getMealById(window.recipeComponents[idx].mealId);
      const def = m?.defaultAmount || 100;
      window.recipeComponents[idx].amount = Math.round(safeNum(e.target.value) * def);
      const card = e.target.closest(".card");
      const amtInput = card.querySelector("[data-recipe-amount]");
      if(amtInput) amtInput.value = window.recipeComponents[idx].amount;
      updateRecipeTotals();
    }
  });
  
  document.getElementById("recipeIngredientList")?.addEventListener("click", (e) => {
    const delIdx = e.target.dataset.recipeDel;
    if(delIdx !== undefined){
      window.recipeComponents.splice(delIdx, 1);
      renderRecipeIngredients();
      updateRecipeTotals();
    }
  });
  
  document.getElementById("btnRecipeEatNow")?.addEventListener("click", handleRecipeEatNow);
  document.getElementById("btnRecipeSave")?.addEventListener("click", handleRecipeSave);
  document.getElementById("btnRecipeShare")?.addEventListener("click", () => {
    if(currentEditingRecipeId) openShareModal(currentEditingRecipeId);
  });
  document.getElementById("btnRecipeCancel")?.addEventListener("click", closeRecipeBuilder);
  document.getElementById("recipeBuilderModalBack")?.addEventListener("click", (e) => {
    if(e.target.id === "recipeBuilderModalBack") closeRecipeBuilder();
  });
}

function deleteMealEntry(entryId){
  window.todayMealEntries = (window.todayMealEntries || []).filter(e => e.entryId !== entryId);
}

/* ---------- Barcode lookup (Open Food Facts) ---------- */
let lastOff = { barcode: null, product: null, kcal100: null, kcalServing: null, displayName: null };

function offGetKcalFromNutriments(n){
  if(!n || typeof n !== "object") return {kcal100: null, kcalServing: null};
  let kcal100 = n["energy-kcal_100g"];
  let kcalServing = n["energy-kcal_serving"];

  if((kcal100 == null || kcal100 === "") && n["energy_100g"] != null){
    const unit = String(n["energy_unit"] || "").toLowerCase();
    const e = Number(n["energy_100g"]);
    if(Number.isFinite(e) && unit === "kj") kcal100 = e / 4.184;
    else if(Number.isFinite(e) && unit === "kcal") kcal100 = e;
  }
  if((kcalServing == null || kcalServing === "") && n["energy_serving"] != null){
    const unit = String(n["energy_unit"] || "").toLowerCase();
    const e = Number(n["energy_serving"]);
    if(Number.isFinite(e) && unit === "kj") kcalServing = e / 4.184;
    else if(Number.isFinite(e) && unit === "kcal") kcalServing = e;
  }

  const norm = (x) => {
    const v = Number(x);
    return Number.isFinite(v) ? Math.round(v) : null;
  };
  return {kcal100: norm(kcal100), kcalServing: norm(kcalServing)};
}
async function fetchOffProductByBarcode(code){
  const cleaned = String(code || "").trim();
  if(!cleaned) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(cleaned)}?fields=code,product_name,product_name_en,brands,quantity,serving_size,nutriments,ingredients_text,ingredients_text_en`;
  const r = await fetch(url);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if(data && data.status === 0) return null;
  if(data && data.product) return data.product;
  if(data && data.code) return data;
  return null;
}
function offPickDisplayName(p){
  const name = p.product_name || p.product_name_en || "Без названия";
  const brands = (p.brands || "").trim();
  return brands ? `${name} (${brands})` : name;
}
async function ensureOffMealExists({barcode, product, category}){
  const id = `off-${barcode}`;
  let existing = (window.meals || []).find(m => m.id === id);
  const nutr = product?.nutriments || {};
  const {kcal100, kcalServing} = offGetKcalFromNutriments(nutr);
  const kcal = (kcalServing != null) ? kcalServing : (kcal100 != null ? kcal100 : 0);

  const short =
    (kcalServing != null) ? `OFF: ${kcalServing} ккал/порц` :
    (kcal100 != null) ? `OFF: ${kcal100} ккал/100г` :
    `OFF: нет ккал`;

  const baseMeal = {
    id,
    category,
    name: offPickDisplayName(product),
    calories: Math.max(1, Math.round(Number(kcal || 0) || 0)) || 1,
    short,
    prep: "",
    proteinG: Math.round(Number(document.getElementById("mProtein")?.value || 0)),
    fluidMl: Math.round(Number(document.getElementById("mFluid")?.value || 0)),
    favorite: false,
    updatedAt: new Date().toISOString(),
    source: "openfoodfacts",
    barcode: String(barcode)
  };

  if(existing){
    existing = {...existing, ...baseMeal, favorite: existing.favorite ?? false};
    await txPut("meals", existing);
  } else {
    await txPut("meals", baseMeal);
  }

  window.meals = await txGetAll("meals");
  return id;
}

async function searchFood(terms){
  const cleaned = String(terms || "").trim();
  const lowerTerms = cleaned.toLowerCase();
  if(!cleaned) return [];
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cleaned)}&search_simple=1&action=process&json=1&fields=code,product_name,product_name_en,brands,nutriments`;
  const r = await window.fetch(url);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if(!data || !data.products) return [];
  
  const results = data.products.map(p => {
    const {kcal100} = offGetKcalFromNutriments(p.nutriments || {});
    return {
      id: p.code,
      name: offPickDisplayName(p),
      calories: kcal100 || 0,
      proteinG: Math.round(Number(p.nutriments?.proteins_100g || 0)),
      raw: p,
      source: 'off'
    };
  });

  // Sorting logic to prioritize generic and exact matches
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    
    // 1. Exact match priority
    const aExact = aName === lowerTerms;
    const bExact = bName === lowerTerms;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    // 2. Generic (no brand) priority
    const aGeneric = !pGenericCheck(a.raw);
    const bGeneric = !pGenericCheck(b.raw);
    if (aGeneric && !bGeneric) return -1;
    if (!aGeneric && bGeneric) return 1;
    
    // 3. "Starts with" priority
    const aStarts = aName.startsWith(lowerTerms);
    const bStarts = bName.startsWith(lowerTerms);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    
    // 4. Shortest name priority
    return aName.length - bName.length;
  });

  return results;
}

function pGenericCheck(p){
  return (p.brands && String(p.brands).trim().length > 0);
}

const genericFoods = [
  // Fruits
  { name: 'Яблоко', calories: 52, proteinG: 0.3, fluidMl: 86, portionG: 180, unit: 'г', type: 'ingredient' },
  { name: 'Банан', calories: 89, proteinG: 1.1, fluidMl: 75, portionG: 120, unit: 'г', type: 'ingredient' },
  { name: 'Апельсин', calories: 43, proteinG: 1, fluidMl: 87, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Груша', calories: 42, proteinG: 0.4, fluidMl: 84, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Абрикос', calories: 44, proteinG: 0.9, fluidMl: 86, portionG: 40, unit: 'г', type: 'ingredient' },
  { name: 'Виноград', calories: 65, proteinG: 0.6, fluidMl: 81, portionG: 100, unit: 'г', type: 'ingredient' },
  { name: 'Лимон', calories: 34, proteinG: 0.9, fluidMl: 89, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Клубника', calories: 33, proteinG: 0.8, fluidMl: 91, portionG: 100, unit: 'г', type: 'ingredient' },
  
  // Vegetables
  { name: 'Огурец', calories: 15, proteinG: 0.8, fluidMl: 95, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Помидор', calories: 18, proteinG: 0.9, fluidMl: 94, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Картофель', calories: 77, proteinG: 2, fluidMl: 79, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Морковь', calories: 41, proteinG: 0.9, fluidMl: 88, portionG: 100, unit: 'г', type: 'ingredient' },
  { name: 'Лук репчатый', calories: 40, proteinG: 1.1, fluidMl: 89, portionG: 80, unit: 'г', type: 'ingredient' },
  { name: 'Капуста белокочанная', calories: 25, proteinG: 1.3, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Свекла', calories: 42, proteinG: 1.5, fluidMl: 86, portionG: 100, unit: 'г', type: 'ingredient' },
  { name: 'Баклажан', calories: 24, proteinG: 1.2, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Кабачок', calories: 23, proteinG: 0.6, fluidMl: 95, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Тыква', calories: 22, proteinG: 1, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Перец болгарский', calories: 27, proteinG: 1.3, fluidMl: 92, portionG: 100, unit: 'г', type: 'ingredient' },
  { name: 'Чеснок', calories: 143, proteinG: 6.5, fluidMl: 59, portionG: 5, unit: 'г', type: 'ingredient' },
  
  // Grains / Pasta (Dry)
  { name: 'Рис (сухой)', calories: 344, proteinG: 6.7, fluidMl: 12, portionG: 80, unit: 'г', type: 'ingredient' },
  { name: 'Гречка (сухая)', calories: 313, proteinG: 12.6, fluidMl: 13, portionG: 80, unit: 'г', type: 'ingredient' },
  { name: 'Овсянка (сухая)', calories: 342, proteinG: 12.3, fluidMl: 8, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Макароны (сухие)', calories: 350, proteinG: 12, fluidMl: 10, portionG: 100, unit: 'г', type: 'ingredient' },
  { name: 'Манка (сухая)', calories: 328, proteinG: 10.3, fluidMl: 13, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Булгур (сухой)', calories: 342, proteinG: 12.3, fluidMl: 9, portionG: 80, unit: 'г', type: 'ingredient' },
  { name: 'Чечевица (сухая)', calories: 310, proteinG: 24, fluidMl: 10, portionG: 80, unit: 'г', type: 'ingredient' },
  
  // Meat & Poultry (Raw)
  { name: 'Куриная грудка (сырая)', calories: 110, proteinG: 23.1, fluidMl: 74, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Куриное бедро (сырое)', calories: 190, proteinG: 16.5, fluidMl: 68, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Индейка (филе, сырое)', calories: 115, proteinG: 24, fluidMl: 72, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Говядина (нежирная, сырая)', calories: 133, proteinG: 19, fluidMl: 65, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Свинина (нежирная, сырая)', calories: 259, proteinG: 16, fluidMl: 58, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Фарш домашний (свин+гов)', calories: 263, proteinG: 17, fluidMl: 55, portionG: 200, unit: 'г', type: 'ingredient' },
  
  // Fish (Raw)
  { name: 'Лосось / Семга (сырая)', calories: 203, proteinG: 20, fluidMl: 60, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Треска (сырая)', calories: 78, proteinG: 18, fluidMl: 81, portionG: 200, unit: 'г', type: 'ingredient' },
  { name: 'Горбуша (сырая)', calories: 142, proteinG: 21, fluidMl: 70, portionG: 200, unit: 'г', type: 'ingredient' },
  
  // Dairy & Eggs
  { name: 'Яйцо куриное', calories: 143, proteinG: 12.6, fluidMl: 75, portionG: 55, unit: 'г', type: 'ingredient' },
  { name: 'Молоко 2.5%', calories: 52, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid' },
  { name: 'Молоко 3.2%', calories: 60, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid' },
  { name: 'Кефир 1%', calories: 38, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid' },
  { name: 'Кефир 3.2%', calories: 57, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid' },
  { name: 'Творог 5%', calories: 121, proteinG: 17.2, fluidMl: 71, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Творог 9%', calories: 159, proteinG: 16, fluidMl: 68, portionG: 150, unit: 'г', type: 'ingredient' },
  { name: 'Сметана 10%', calories: 115, proteinG: 2.7, fluidMl: 82, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Сметана 15%', calories: 160, proteinG: 3, fluidMl: 75, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Сметана 20%', calories: 204, proteinG: 2.8, fluidMl: 72, portionG: 50, unit: 'г', type: 'ingredient' },
  { name: 'Сыр Российский', calories: 360, proteinG: 23, fluidMl: 40, portionG: 30, unit: 'г', type: 'ingredient' },
  { name: 'Масло сливочное 82.5%', calories: 748, proteinG: 0.8, fluidMl: 16, portionG: 10, unit: 'г', type: 'ingredient' },
  
  // Fats & Other
  { name: 'Масло подсолнечное', calories: 899, proteinG: 0, fluidMl: 0, portionG: 10, unit: 'г', type: 'ingredient' },
  { name: 'Масло оливковое', calories: 898, proteinG: 0, fluidMl: 0, portionG: 10, unit: 'г', type: 'ingredient' },
  { name: 'Сахар', calories: 398, proteinG: 0, fluidMl: 0, portionG: 10, unit: 'г', type: 'ingredient' },
  { name: 'Мед', calories: 304, proteinG: 1, fluidMl: 17, portionG: 20, unit: 'г', type: 'ingredient' }
];



async function searchFoodUSDA(terms, forceOnline = false){



  const cleaned = String(terms || "").trim();



  const lowerTerms = cleaned.toLowerCase();



  if(!cleaned) return [];



  



  // 1. Search in local high-quality generic list



  const localMatches = genericFoods.filter(f => f.name.toLowerCase().includes(lowerTerms))



    .map(f => ({



      id: `local-${f.name}`,



      name: f.name,



      calories: f.calories,



      proteinG: f.proteinG,



      source: 'local-generic',



      priority: 10,



      unit: f.unit || 'г',



      defaultAmount: f.defaultAmount || 100



    }));







  // Logic: 



  // - If not forcing online and we have local matches, return them immediately (saves data/time)



  // - If no local matches, fallback to API automatically



  // - If forcing online, we do the API call regardless



  if (!forceOnline && localMatches.length > 0) {



    return localMatches;



  }







  // 2. Search OFF



  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cleaned)}&search_simple=1&action=process&json=1&fields=code,product_name,product_name_en,brands,nutriments,categories_tags&page_size=50`;



  



  try {



    const r = await fetch(url);



    if(!r.ok) throw new Error(`HTTP ${r.status}`);



    const data = await r.json();



    



    const apiResults = (data.products || [])



      .map(p => {



        const {kcal100} = offGetKcalFromNutriments(p.nutriments || {});



        const isGeneric = !pGenericCheck(p);



        const isRawCategory = (p.categories_tags || []).some(cat => 



          cat.includes('unprocessed') || cat.includes('raw') || cat.includes('fresh') || cat.includes('fruit') || cat.includes('vegetable')



        );



        



        return {



          id: p.code,



          name: offPickDisplayName(p),



          calories: kcal100 || 0,



          proteinG: Math.round(Number(p.nutriments?.proteins_100g || 0)),



          raw: p,



          source: 'off-generic',



          priority: (isGeneric ? 2 : 0) + (isRawCategory ? 1 : 0)



        };



      })



      .filter(res => res.calories > 0);







    const results = [...localMatches, ...apiResults];







    // Sorting



    results.sort((a, b) => {



      if (b.priority !== a.priority) return b.priority - a.priority;



      const aName = a.name.toLowerCase();



      const bName = b.name.toLowerCase();



      const aExact = aName === lowerTerms;



      const bExact = bName === lowerTerms;



      if (aExact && !bExact) return -1;



      if (!aExact && bExact) return 1;



      return aName.length - bName.length;



        });



    



        return results.slice(0, 20);



      } catch {



        return localMatches; 



      }



}

window.searchFood = searchFood;
window.searchFoodUSDA = searchFoodUSDA;

function renderOffProduct(product, code){
  const root = document.getElementById("barcodeResult");
  if(!product){
    lastOff = { barcode: code, product: null, kcal100: null, kcalServing: null, displayName: null };
    root.innerHTML = `<div class="card"><div style="font-weight:900">Не найдено</div><div class="muted">Штрихкод: ${escapeHtml(code)}</div></div>`;
    return;
  }

  const displayName = offPickDisplayName(product);
  const quantity = product.quantity || "";
  const serving = product.serving_size || "";
  const nutr = product.nutriments || {};
  const {kcal100, kcalServing} = offGetKcalFromNutriments(nutr);

  lastOff = { barcode: code, product, kcal100, kcalServing, displayName };

  const kcalLine = [
    (kcal100 != null ? `<div><b>${kcal100}</b> ккал/100г</div>` : `<div class="muted">Ккал/100г: нет данных</div>`),
    (kcalServing != null ? `<div><b>${kcalServing}</b> ккал/порц</div>` : `<div class="muted">Ккал/порция: нет данных</div>`)
  ].join("");

  root.innerHTML = `
    <div class="card">
      <div style="font-weight:900">${escapeHtml(displayName)}</div>
      <div class="muted" style="margin-top:6px">
        ${quantity ? `Упаковка: ${escapeHtml(quantity)}<br>` : ""}
        ${serving ? `Порция: ${escapeHtml(serving)}<br>` : ""}
        Штрихкод: ${escapeHtml(product.code || code)}
      </div>

      <div style="margin-top:10px">${kcalLine}</div>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px">
        <button class="btn secondary" id="btnOffAddTo">Добавить</button>
        <button class="btn" id="btnOffEatSnack">Съесть</button>
      </div>
    </div>
  `;

  document.getElementById("btnOffAddTo")?.addEventListener("click", () => {
    if(!lastOff?.product) return;
    
    const nutr = lastOff.product.nutriments || {};
    const {kcal100, kcalServing} = offGetKcalFromNutriments(nutr);
    
    openAddMealModal({
      name: lastOff.displayName,
      calories: kcal100 || 0,
      proteinG: Math.round(Number(nutr.proteins_100g || 0)),
      fluidMl: 0,
      portionG: kcalServing && kcal100 ? Math.round(kcalServing * 100 / kcal100) : 100,
      type: "ingredient"
    });
  });

  document.getElementById("btnOffEatSnack")?.addEventListener("click", async () => {
    if(!lastOff?.product){ setStatus("Нет данных продукта."); return; }
    
    const displayName = lastOff.displayName;
    const nutr = lastOff.product.nutriments || {};
    const {kcal100, kcalServing} = offGetKcalFromNutriments(nutr);
    
    const amount = kcalServing && kcal100 ? Math.round(kcalServing * 100 / kcal100) : 100;
    const divisor = amount / 100;

    openClassificationModal(async (selectedCat) => {
      const snap = {
        id: uid("temp"),
        category: selectedCat,
        name: displayName,
        calories: Math.round((kcal100 || 0)),
        proteinG: Math.round(Number(nutr.proteins_100g || 0)),
        fluidMl: 0,
        portionG: amount,
        isTemporary: true
      };
      
      addMealToToday(null, amount, snap);
      
      const finalize = async () => {
        await saveDraft();
        renderDaySummary();
        updateTopTotals();
        setStatus("Добавлено (разово).");
      };

      if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
        saveDraft(); renderDaySummary(); updateTopTotals(); setStatus("Добавлено (разово).");
      } else {
        finalize();
      }
    });
  });
}

/* ---------- Scanner (Native/jsQR) ---------- */
let scannerStream = null;
let scannerDevices = [];
let currentScannerDeviceIndex = 0;

/**
 * Stops the scanner stream and releases the camera.
 */
function stopScannerStream() {
  if (scannerStream) {
    scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
  }
}

/**
 * Initializes the camera stream for scanning.
 * Defaults to environment facing mode for mobile.
 */
async function initScannerStream(constraints = { video: { facingMode: "environment" } }) {
  console.log("Initializing scanner stream with constraints:", constraints);
  stopScannerStream();
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log("Scanner stream initialized successfully:", scannerStream.id);
    return scannerStream;
  } catch (err) {
    console.error("Failed to initialize scanner stream:", err);
    // Fallback for devices without 'environment' camera (like some laptops)
    if (constraints.video && constraints.video.facingMode === "environment") {
      console.log("Retrying with default video constraints...");
      return initScannerStream({ video: true });
    }
    throw err;
  }
}

/**
 * Cycles through available cameras.
 */
async function cycleScannerCamera() {
  if (scannerDevices.length === 0) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    scannerDevices = devices.filter(d => d.kind === "videoinput");
  }
  if (scannerDevices.length < 2) return null;

  currentScannerDeviceIndex = (currentScannerDeviceIndex + 1) % scannerDevices.length;
  const device = scannerDevices[currentScannerDeviceIndex];
  return initScannerStream({ video: { deviceId: { exact: device.deviceId } } });
}
let scannerRafId = null;
let scannerActive = false;
let scannerCanvas = null;
let scannerContext = null;

/**
 * The main detection loop using requestAnimationFrame.
 */
async function detectionLoop(video, callback) {
  if (!scannerActive) return;

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    if (window.checkScannerSupport()) {
      // Native BarcodeDetector API
      try {
        const detector = new window.BarcodeDetector();
        const barcodes = await detector.detect(video);
        if (barcodes.length > 0 && scannerActive) {
          console.log("Native BarcodeDetector found:", barcodes[0].rawValue.substring(0, 30) + "...");
          callback(barcodes[0].rawValue);
        }
                } catch (err) {
                  console.error("BarcodeDetector error:", err);
                }
              }
            }
  if (scannerActive) {
    scannerRafId = requestAnimationFrame(() => detectionLoop(video, callback));
  }
}

/**
 * Starts the detection loop.
 */
function startDetectionLoop(video, callback) {
  console.log("Starting detection loop...");
  scannerActive = true;
  detectionLoop(video, callback);
}

/**
 * Stops the detection loop and cancels pending frames.
 */
function stopDetectionLoop() {
  console.log("Stopping detection loop.");
  scannerActive = false;
  if (scannerRafId) {
    cancelAnimationFrame(scannerRafId);
    scannerRafId = null;
  }
}

/**
 * Stops the scanner completely (stream and loop).
 */
function stopScanner() {
  stopDetectionLoop();
  stopScannerStream();
}

// Automatically stop scanner when tab is hidden
document.addEventListener("visibilitychange", () => {
  if (document.hidden && scannerActive) {
    console.log("Tab hidden, stopping scanner...");
    stopScanner();
  }
});

window.stopScanner = stopScanner;

async function stopScan(){
  stopScanner();
  const video = document.getElementById("scanVideo");
  if(video){
    try{ video.pause(); }catch{}
    video.srcObject = null;
  }
  document.getElementById("btnScanStart")?.classList.remove("hidden");
  document.getElementById("btnScanStop")?.classList.add("hidden");
  document.getElementById("scanCard")?.classList.add("hidden");
}

/**
 * Generic hybrid scanner starter.
 */
async function startHybridScanner(video, hint, onFound) {
  if (hint) hint.textContent = "Загрузка…";
  
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Камера недоступна. Требуется HTTPS или localhost.");
    return;
  }

        try {
          if (hint) hint.textContent = "Доступ к камере…";
          const stream = await initScannerStream();    video.srcObject = stream;
    video.setAttribute("playsinline", true);
    await video.play();

    startDetectionLoop(video, (result) => {
      if (result) {
        onFound(result);
      }
    });

    if (hint) hint.textContent = "Сканирую…";
  } catch (err) {
    console.error("Scanner error:", err);
    if (hint) hint.textContent = "Ошибка камеры.";
    stopScanner();
  }
}

async function startScan(){
  const hint = document.getElementById("scanHint");
  const scanCard = document.getElementById("scanCard");
  const video = document.getElementById("scanVideo");
  
  if(scanCard) {
    scanCard.classList.remove("hidden");
    scanCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.getElementById("btnScanStart")?.classList.add("hidden");
  document.getElementById("btnScanStop")?.classList.remove("hidden");

  await startHybridScanner(video, hint, async (text) => {
    if (hint) hint.textContent = `Найдено: ${text}`;
    const input = document.getElementById("barcodeInput");
    if (input) input.value = text;
    await stopScan();
    document.getElementById("btnBarcodeSearch")?.click();
  });
}

function wireBarcodeSearch(){
  const input = document.getElementById("barcodeInput");
  const btn = document.getElementById("btnBarcodeSearch");
  const pasteBtn = document.getElementById("btnBarcodePaste");

  async function run(){
    const code = String(input.value || "").trim();
    if(!code){ setStatus("Введите штрихкод."); return; }
    document.getElementById("barcodeResult").innerHTML = `<div class="card"><div class="muted">Поиск…</div></div>`;
    try{
      const p = await fetchOffProductByBarcode(code);
      renderOffProduct(p, code);
      setStatus(p ? "Готово." : "Не найдено.");
    }catch(err){
      document.getElementById("barcodeResult").innerHTML = `<div class="card"><div style="font-weight:900">Ошибка</div><div class="muted">${escapeHtml(err?.message || String(err))}</div></div>`;
      setStatus("Ошибка поиска.");
    }
  }

  btn?.addEventListener("click", run);
  input?.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){ e.preventDefault(); run(); }
  });

  pasteBtn?.addEventListener("click", async () => {
    try{
      const t = await navigator.clipboard.readText();
      if(t) input.value = t.trim();
      input.focus();
    }catch{
      setStatus("Не удалось прочитать буфер обмена.");
    }
  });

  document.getElementById("btnScanStart")?.addEventListener("click", startScan);
  document.getElementById("btnScanStop")?.addEventListener("click", stopScan);

  document.getElementById("btnSwitchCamera")?.addEventListener("click", async () => {
    const video = document.getElementById("scanVideo");
    const stream = await cycleScannerCamera();
    if (stream && video) video.srcObject = stream;
  });

  document.getElementById("btnSwitchImportCamera")?.addEventListener("click", async () => {
    const video = document.getElementById("importScanVideo");
    const stream = await cycleScannerCamera();
    if (stream && video) video.srcObject = stream;
  });
}

function wireAddButtons(){
  document.querySelectorAll("[data-add-meal]").forEach(btn => {
    btn.addEventListener("click", () => openAddMealModal(btn.getAttribute("data-add-meal")));
  });
  document.getElementById("btnAddActivity")?.addEventListener("click", openAddActivityModal);
}
function wireDraftInputs(){
  [
    "weight","steps","notes",
    "setHeight","setAge","setSex",
    "bmrMultiplier","goalKcal","nettoMode",
    "setAppTitle","autoSaveOnNewDay","favoritesEnabled",
    "proteinPerKg","waterGoalMl"
  ].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;

    const handler = async () => {
      window.bmrMultiplier = Number(document.getElementById("bmrMultiplier")?.value) || window.bmrMultiplier || 1.2;
      window.goalKcal = Number(document.getElementById("goalKcal")?.value) || window.goalKcal || -400;
      window.nettoMode = String(document.getElementById("nettoMode")?.value) || window.nettoMode || "nettonobmr";
      window.proteinPerKg = Number(document.getElementById("proteinPerKg")?.value) || window.proteinPerKg || 0.83;
      window.waterGoalMl = Number(document.getElementById("waterGoalMl")?.value) || window.waterGoalMl || 2000;
      await saveDraft();
      updateTopTotals();
    };

    el.addEventListener("input", handler);
    el.addEventListener("change", handler);

    if(id === "weight"){
      el.addEventListener("change", async () => {
        await metaSet("profile.weight", String(el.value ?? "").trim());
      });
    }
  });
}
function wireGlobalClicks(){
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".btn, .nav-item, .tabbtn, .fab, [class*='btn-']");
    if(btn){
      triggerHaptic();
      visualFeedback(btn);
    }

    const wAdd = ev.target.closest("[data-water-add]");
    if(wAdd){
      const add = Math.round(Number(wAdd.getAttribute("data-water-add") || 0));
      if(add > 0){
        todayWaterMl = Math.max(0, Math.round(Number(todayWaterMl || 0) + add));
        await saveDraft();
        updateTopTotals();
        setStatus(`Вода: +${add} мл`);
      }
      return;
    }
    const wReset = ev.target.closest("[data-water-reset]");
    if(wReset){
      todayWaterMl = 0;
      await saveDraft();
      updateTopTotals();
      setStatus("Вода: сброс.");
      return;
    }


    const favMeal = ev.target.closest("[data-fav-meal]");
    if(favMeal){
      ev.preventDefault(); ev.stopPropagation();
      const id = favMeal.getAttribute("data-fav-meal");
      const m = (window.meals || []).find(x => x.id === id);
      if(m){
        m.favorite = !m.favorite;
        await txPut("meals", {...m, updatedAt:new Date().toISOString()});
        window.meals = await txGetAll("meals");
        renderFoodAll();
        updateTopTotals();
      }
      return;
    }

    const favAct = ev.target.closest("[data-fav-act]");
    if(favAct){
      ev.preventDefault(); ev.stopPropagation();
      const id = favAct.getAttribute("data-fav-act");
      const a = (window.activities || []).find(x => x.id === id);
      if(a){
        a.favorite = !a.favorite;
        await txPut("activities", {...a, updatedAt:new Date().toISOString()});
        window.activities = await txGetAll("activities");
        renderActivities();
        updateTopTotals();
      }
      return;
    }

    const shareBtn = ev.target.closest("[data-meal-share]");
    if(shareBtn){
      const mealId = shareBtn.getAttribute("data-meal-share");
      openShareModal(mealId);
      return;
    }

    const eatBtn = ev.target.closest("[data-meal-eat]");
    if(eatBtn){
      const mealId = eatBtn.getAttribute("data-meal-eat");
      const m = getMealById(mealId);
      const amt = m ? (m.portionG || m.defaultAmount || 100) : 100;

      const finishAdd = (cat) => {
        const promise = incrementUsageScore(mealId);
        addMealToToday(mealId, amt, null, cat);
        const finalize = async () => {
          await promise;
          await saveDraft();
          renderFoodAll();
          renderDaySummary();
          updateTopTotals();
          setStatus("Добавлено.");
        };
        if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
          saveDraft(); renderFoodAll(); renderDaySummary(); updateTopTotals(); setStatus("Добавлено.");
        } else {
          finalize();
        }
      };

      // Always show classification modal for any consumption
      openClassificationModal(finishAdd);
      return;
    }

    const portionBtn = ev.target.closest("[data-meal-portion]");
    if(portionBtn){
      const mealId = portionBtn.getAttribute("data-meal-portion");
      openPortionModal(mealId);
      return;
    }

    const delMealEntry = ev.target.closest("[data-del-meal-entry]");
    if(delMealEntry){
      const entryId = delMealEntry.getAttribute("data-del-meal-entry");
      deleteMealEntry(entryId);
      await saveDraft();
      renderFoodAll();
      renderDaySummary();
      updateTopTotals();
      return;
    }

    const addAct = ev.target.closest("[data-act-add]");
    if(addAct){
      const id = addAct.getAttribute("data-act-add");
      const a = window.activities.find(x => x.id === id);
      const kph = Number(a?.kcalPerHour || 0);

      const kcalEl = document.querySelector(`#activities [data-act-kcal="${CSS.escape(id)}"]`);
      const minEl = document.querySelector(`#activities [data-act-min="${CSS.escape(id)}"]`);

      let minutes = Math.round(Number(minEl?.value || 0));
      if(!minutes){
        const kcal = Math.round(Number(kcalEl?.value || 0));
        minutes = (kcal && kph) ? Math.round(kcal * 60 / kph) : 0;
      }
      if(!minutes || minutes <= 0){
        setStatus("Введите ккал за сессию или минуты (>0)." );
        return;
      }

      const promise = incrementUsageScore(id);
      window.todayActivityEntries.push({id, minutes, activitySnapshot: buildActivitySnapshot(window.activities.find(x => x.id === id)), createdAt: new Date().toISOString()});
      rescheduleDynamicTriggers();
      setTimeout(() => evaluateEventTriggers("activity", id, "activity"), 100);
      if(kcalEl) kcalEl.value = "";
      if(minEl) minEl.value = "";
      
      const finalize = async () => {
        await promise;
        await saveDraft();
        renderActivities();
        renderDaySummary();
        updateTopTotals();
      };

      if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
        saveDraft(); renderActivities(); renderDaySummary(); updateTopTotals();
      } else {
        finalize();
      }
      return;
    }

    const delAct = ev.target.closest("[data-del-act-idx]");
    if(delAct){
      const idx = Number(delAct.getAttribute("data-del-act-idx"));
      window.todayActivityEntries.splice(idx, 1);
      await saveDraft();
      renderActivities();
      renderDaySummary();
      updateTopTotals();
      return;
    }
  });
}

function wireActivityInputs(){
  const listEl = document.getElementById("activityList");
  if(!listEl) return;

  listEl.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      const card = e.target.closest(".card");
      card?.querySelector("[data-act-add]")?.click();
    }
  });

  listEl.addEventListener("input", (e) => {
    const kcalInput = e.target.closest("[data-act-kcal]");
    const minInput = e.target.closest("[data-act-min]");
    if(!kcalInput && !minInput) return;

    const card = e.target.closest(".card");
    const actId = card?.getAttribute("data-act-card");
    const a = (window.activities || []).find(x => x.id === actId);
    if(!a) return;

    const kph = Number(a.kcalPerHour || 0);
    const otherKcal = card.querySelector("[data-act-kcal]");
    const otherMin = card.querySelector("[data-act-min]");

    if(kcalInput){
      if(kcalInput.value === ""){
        if(otherMin) otherMin.value = "";
      } else {
        const kcal = Number(kcalInput.value);
        if(otherMin && kph > 0) {
          otherMin.value = parseFloat((kcal * 60 / kph).toFixed(2));
        }
      }
    } else if(minInput){
      if(minInput.value === ""){
        if(otherKcal) otherKcal.value = "";
      } else {
        const min = Number(minInput.value);
        if(otherKcal) {
          otherKcal.value = parseFloat((min * kph / 60).toFixed(2));
        }
      }
    }
  });
}

async function wireActions(){
  document.getElementById("btnNewRecipe")?.addEventListener("click", () => openRecipeBuilder());
  document.getElementById("btnSaveDay")?.addEventListener("click", async () => {
    const iso = viewDateISO || await getAppDateISO();
    const draft = await metaGet(draftKey(iso));
    if(draft){
      await saveDayLogFromDraft(draft);
      setStatus("Сохранено.");
      if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
        renderLogs();
      } else {
        await renderLogs();
      }
    }
  });
  document.getElementById("btnResetDay")?.addEventListener("click", async () => {
    if(!confirm("Сбросить текущий день?")) return;
    window.todayMealEntries = [];
    window.todayActivityEntries = [];
    todayWaterMl = 0;
    document.getElementById("dashSteps").value = "";
    document.getElementById("notes").value = "";
    await saveDraft();
    renderDaySummary();
    renderActivities();
    updateTopTotals();
    setStatus("Сброшено.");
  });

  document.getElementById("btnQuickAdd")?.addEventListener("click", openQuickAddModal);
  document.getElementById("btnMoreQuickAdd")?.addEventListener("click", () => {
    const moreMenu = document.getElementById("moreMenu");
    if(moreMenu) moreMenu.style.display = "none";
    openQuickAddModal();
  });

  document.getElementById("btnSaveSettings")?.addEventListener("click", saveSettings);
  document.getElementById("btnAddNotification")?.addEventListener("click", () => openNotificationEditModal());
  document.getElementById("btnPersist")?.addEventListener("click", requestPersist);
  document.getElementById("btnExport")?.addEventListener("click", exportBackupNow);
  document.getElementById("btnImport")?.addEventListener("click", () => {
    const fileEl = document.getElementById("importFile");
    const file = fileEl?.files[0];
    if(!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const obj = JSON.parse(text);
        await importBackup(obj);
        alert("Импорт успешно завершён. Страница будет перезагружена.");
        location.reload();
      } catch(err) {
        alert("Ошибка импорта: " + err.message);
      }
    };
    reader.onerror = () => {
      alert("Ошибка чтения файла.");
    };
    reader.readAsText(file);
  });

  document.getElementById("btnImportBundle")?.addEventListener("click", () => {
    openImportModal();
  });

  document.getElementById("btnResetJournal")?.addEventListener("click", async () => {
    if(!confirm("УДАЛИТЬ ВЕСЬ ЖУРНАЛ? Блюда и активности останутся.")) return;
    await txClear("logs");
    const keys = (await txGetAll("meta")).map(m => m.key).filter(k => k.startsWith("draft:"));
    for(const k of keys) await txDelete("meta", k);
    location.reload();
  });

  document.getElementById("btnFactoryReset")?.addEventListener("click", async () => {
    if(!confirm("УДАЛИТЬ ВООБЩЕ ВСЕ ДАННЫЕ? Это действие необратимо.")) return;
    if(!confirm("ВЫ УВЕРЕНЫ? Удалятся все блюда, активности, настройки и логи.")) return;
    
    await txClear("meals");
    await txClear("activities");
    await txClear("logs");
    await txClear("shopping");
    await txClear("meta");
    
    // Clear localStorage just in case any keys were there
    localStorage.clear();
    
    alert("Все данные удалены. Приложение будет перезагружено.");
    location.reload();
  });

  document.getElementById("dbgEnabled")?.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    await metaSet("debug.enabled", enabled);
    if(enabled) {
      await advanceAppDateIfDebug();
      location.reload();
    } else {
      await metaSet("debug.dateISO", null);
      location.reload();
    }
  });

  document.getElementById("dbgReset")?.addEventListener("click", async () => {
    await metaSet("debug.dateISO", null);
    await metaSet("debug.enabled", false);
    location.reload();
  });

  document.getElementById("btnSaveShopping")?.addEventListener("click", saveShopping);

  const netTile = document.getElementById("netTile");
  netTile?.addEventListener("click", cycleNettoMode);

  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const nav = item.dataset.nav;
      if(nav === "more"){
        pushModalState("moreMenu");
        document.getElementById("moreMenu").style.display = "block";
        return;
      }
      switchTab(nav);
    });
  });

  document.getElementById("closeMoreMenu")?.addEventListener("click", closeMoreMenu);

  document.querySelectorAll("[data-more-link]").forEach(link => {
    link.addEventListener("click", () => {
      const targetTab = link.dataset.moreLink;
      if (targetTab === "import-bundle") {
        closeMoreMenu();
        setTimeout(() => {
          if (typeof openImportModal === "function") {
            openImportModal();
          }
        }, 150);
      } else {
        switchTab(targetTab);
      }
    });
  });

  const dp = document.getElementById("datePicker");
  dp?.addEventListener("change", async () => {
    await applyViewDate(dp.value);
  });
  
  const headerDateContainer = document.getElementById("headerDateContainer");
  if(headerDateContainer){
    headerDateContainer.addEventListener("click", () => {
      showDatePicker();
    });
  }

  const ds = document.getElementById("dashSteps");
  const dw = document.getElementById("dashWeight");
  const sw = document.getElementById("weight");

  const scrollToTop = () => {
    // Small delay to let keyboard appear first
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 100);
  };

  ds?.addEventListener("focus", scrollToTop);
  dw?.addEventListener("focus", scrollToTop);

  ds?.addEventListener("change", async () => {
    await saveDraft();
    await refreshDateUI();
    visualFeedback(ds);
    triggerHaptic();
  });

  dw?.addEventListener("change", async () => {
    sw.value = dw.value;
    await metaSet("profile.weight", dw.value);
    await saveDraft();
    updateTopTotals();
    await refreshDateUI();
    visualFeedback(dw);
    triggerHaptic();
  });

  sw?.addEventListener("change", async () => {
    if(dw) dw.value = sw.value;
    await metaSet("profile.weight", sw.value);
    await saveDraft();
    updateTopTotals();
    await refreshDateUI();
    visualFeedback(sw);
    triggerHaptic();
  });

  // Initialize Search
  const foodSearchCont = document.getElementById("foodSearchContainer");
  if(foodSearchCont) foodSearchCont.innerHTML = renderSearchInput("foodSearch", "Поиск в списке...");
  
  const actSearchCont = document.getElementById("activitiesSearchContainer");
  if(actSearchCont) actSearchCont.innerHTML = renderSearchInput("actSearch", "Поиск занятий...");

  wireSearch("foodSearch", "foodList");
  wireSearch("actSearch", "activityList");

  installLongPress(document.getElementById("foodList"), "[data-meal-card]", el => el.getAttribute("data-meal-card"), openEditMealModal);
  installLongPress(document.getElementById("activityList"), "[data-act-card]", el => el.getAttribute("data-act-card"), openEditActivityModal);

  applyTabUI("day");
}

function seedMealsIfEmpty(arr){
  const generic = [
    // Fruits
    { id: 'g-apple', name: 'Яблоко', calories: 52, proteinG: 0.3, fluidMl: 86, portionG: 180, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 180 },
    { id: 'g-banana', name: 'Банан', calories: 89, proteinG: 1.1, fluidMl: 75, portionG: 120, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 120 },
    { id: 'g-orange', name: 'Апельсин', calories: 43, proteinG: 1, fluidMl: 87, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-pear', name: 'Груша', calories: 42, proteinG: 0.4, fluidMl: 84, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-apricot', name: 'Абрикос', calories: 44, proteinG: 0.9, fluidMl: 86, portionG: 40, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 40 },
    { id: 'g-grape', name: 'Виноград', calories: 65, proteinG: 0.6, fluidMl: 81, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    { id: 'g-lemon', name: 'Лимон', calories: 34, proteinG: 0.9, fluidMl: 89, portionG: 50, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 50 },
    { id: 'g-strawb', name: 'Клубника', calories: 33, proteinG: 0.8, fluidMl: 91, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    // Vegetables
    { id: 'g-cucumber', name: 'Огурец', calories: 15, proteinG: 0.8, fluidMl: 95, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-tomato', name: 'Помидор', calories: 18, proteinG: 0.9, fluidMl: 94, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-potato', name: 'Картофель', calories: 77, proteinG: 2, fluidMl: 79, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-carrot', name: 'Морковь', calories: 41, proteinG: 0.9, fluidMl: 88, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    { id: 'g-onion', name: 'Лук репчатый', calories: 40, proteinG: 1.1, fluidMl: 89, portionG: 80, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 80 },
    { id: 'g-cabbage', name: 'Капуста белокочанная', calories: 25, proteinG: 1.3, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-beet', name: 'Свекла', calories: 42, proteinG: 1.5, fluidMl: 86, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    { id: 'g-eggplant', name: 'Баклажан', calories: 24, proteinG: 1.2, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-zucchini', name: 'Кабачок', calories: 23, proteinG: 0.6, fluidMl: 95, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-pumpkin', name: 'Тыква', calories: 22, proteinG: 1, fluidMl: 92, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-pepper', name: 'Перец болгарский', calories: 27, proteinG: 1.3, fluidMl: 92, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    { id: 'g-garlic', name: 'Чеснок', calories: 143, proteinG: 6.5, fluidMl: 59, portionG: 5, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 5 },
    // Grains
    { id: 'g-buckwheat', name: 'Гречка (сухая)', calories: 313, proteinG: 12.6, fluidMl: 13, portionG: 80, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 80 },
    { id: 'g-rice', name: 'Рис (сухой)', calories: 344, proteinG: 6.7, fluidMl: 12, portionG: 80, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 80 },
    { id: 'g-oats', name: 'Овсянка (сухая)', calories: 342, proteinG: 12.3, fluidMl: 8, portionG: 50, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 50 },
    { id: 'g-pasta', name: 'Макароны (сухие)', calories: 350, proteinG: 12, fluidMl: 10, portionG: 100, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 100 },
    { id: 'g-semolina', name: 'Манка (сухая)', calories: 328, proteinG: 10.3, fluidMl: 13, portionG: 50, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 50 },
    { id: 'g-bulgur', name: 'Булгур (сухой)', calories: 342, proteinG: 12.3, fluidMl: 9, portionG: 80, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 80 },
    { id: 'g-lentils', name: 'Чечевица (сухая)', calories: 310, proteinG: 24, fluidMl: 10, portionG: 80, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 80 },
    // Meat
    { id: 'g-chicken-br', name: 'Куриная грудка (сырая)', calories: 110, proteinG: 23.1, fluidMl: 74, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-chicken-th', name: 'Куриное бедро (сырое)', calories: 190, proteinG: 16.5, fluidMl: 68, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-turkey', name: 'Индейка (филе, сырое)', calories: 115, proteinG: 24, fluidMl: 72, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-beef', name: 'Говядина (нежирная, сырая)', calories: 133, proteinG: 19, fluidMl: 65, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-pork', name: 'Свинина (нежирная, сырая)', calories: 259, proteinG: 16, fluidMl: 58, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-mince', name: 'Фарш домашний (свин+гов)', calories: 263, proteinG: 17, fluidMl: 55, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    // Fish
    { id: 'g-salmon', name: 'Лосось / Семга (сырая)', calories: 203, proteinG: 20, fluidMl: 60, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-cod', name: 'Треска (сырая)', calories: 78, proteinG: 18, fluidMl: 81, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    { id: 'g-pink-sal', name: 'Горбуша (сырая)', calories: 142, proteinG: 21, fluidMl: 70, portionG: 200, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 200 },
    // Dairy
    { id: 'g-egg', name: 'Яйцо куриное', calories: 143, proteinG: 12.6, fluidMl: 75, portionG: 55, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 55 },
    { id: 'g-milk25', name: 'Молоко 2.5%', calories: 52, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid', category: 'snack', defaultAmount: 200 },
    { id: 'g-milk32', name: 'Молоко 3.2%', calories: 60, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid', category: 'snack', defaultAmount: 200 },
    { id: 'g-kefir1', name: 'Кефир 1%', calories: 38, proteinG: 3, fluidMl: 100, portionG: 200, unit: 'г', type: 'liquid', category: 'snack', defaultAmount: 200 },
    { id: 'g-cottage5', name: 'Творог 5%', calories: 121, proteinG: 17.2, fluidMl: 71, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-cottage9', name: 'Творог 9%', calories: 159, proteinG: 16, fluidMl: 68, portionG: 150, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 150 },
    { id: 'g-sour15', name: 'Сметана 15%', calories: 160, proteinG: 3, fluidMl: 75, portionG: 50, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 50 },
    { id: 'g-cheese-rus', name: 'Сыр Российский', calories: 360, proteinG: 23, fluidMl: 40, portionG: 30, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 30 },
    { id: 'g-butter', name: 'Масло сливочное 82.5%', calories: 748, proteinG: 0.8, fluidMl: 16, portionG: 10, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 10 },
    // Others
    { id: 'g-oil-sun', name: 'Масло подсолнечное', calories: 899, proteinG: 0, fluidMl: 0, portionG: 10, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 10 },
    { id: 'g-sugar', name: 'Сахар', calories: 398, proteinG: 0, fluidMl: 0, portionG: 10, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 10 },
    { id: 'g-honey', name: 'Мед', calories: 304, proteinG: 1, fluidMl: 17, portionG: 20, unit: 'г', type: 'ingredient', category: 'snack', defaultAmount: 20 }
  ];

  const existingIds = new Set(arr.map(m => m.id));
  const newItems = generic
    .filter(g => !existingIds.has(g.id))
    .map(m => ({...m, favorite: false, updatedAt: new Date().toISOString()}));
  
  return [...arr, ...newItems];
}

async function loadAll(){
  await checkAndApplyDecay();
  const allMeals = await txGetAll("meals");
  window.meals = seedMealsIfEmpty(allMeals);
  
  if (window.meals.length > allMeals.length) {
    await txBulkPut("meals", window.meals);
  }

  window.activities = seedActivitiesIfEmpty(await txGetAll("activities"));
  
  const allNotifs = await txGetAll("notifications");
  window.notifications = seedNotificationsIfEmpty(allNotifs);
  if (window.notifications.length > allNotifs.length) {
    for (const n of window.notifications) {
      if (!allNotifs.find(x => x.id === n.id)) await txPut("notifications", n);
    }
  }

  await loadSettings();
  await loadShopping();
  await migrateLegacyDraftOnce();
  await autoSaveDraftIfDateChanged();
  await applyViewDate(await getAppDateISO());
  
  if (typeof window !== 'undefined' && (window.__TEST__ || window.jest)) {
    renderLogs();
  } else {
    await renderLogs();
  }
}

function wireFab() {
  const fab = document.getElementById("fab");
  if (!fab) return;

  fab.addEventListener("click", () => {
    const state = history.state || { tab: "day" };
    const tab = state.tab;

    if (tab === "activities") {
      if (typeof window.openAddActivityModal === "function") window.openAddActivityModal();
    } else if (tab === "food") {
      const type = window.currentFoodType || currentFoodType;
      if (type === "recipe") {
        if (typeof window.openRecipeBuilder === "function") {
          window.openRecipeBuilder();
        }
      } else {
        if (typeof window.openAddMealModal === "function") {
          window.openAddMealModal(type);
        }
      }
    }
  });
}

function wireTabsAndEditors(){
  // Main tabs
  document.querySelectorAll(".tabs .tabbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Food sub-tabs (now in master-header)
  document.querySelectorAll(".food-sub-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.foodType;
      window.currentFoodType = type;
      currentFoodType = type;
      
      document.querySelectorAll(".food-sub-tab").forEach(b => {
        b.classList.toggle("active", b.dataset.foodType === type);
      });
      
      // Clear search on sub-tab switch
      const search = document.getElementById("foodSearch");
      if(search) {
        search.value = "";
        const clearBtn = document.getElementById("foodSearch-clear");
        if(clearBtn) clearBtn.classList.add("hidden");
        applySearchFilter("foodList", "");
      }

      renderFoodAll();
    });
  });
}

    async function checkUrlForSharedRecipe(){
      const params = new URLSearchParams(window.location.search);
      const recipeData = params.get('recipe');
      if (recipeData) {
        console.log('Shared recipe detected in URL');
        await handleLinkImport(recipeData);
        
        // Clean up URL to prevent re-import on refresh
        const newUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    }

    async function handleLinkImport(compressedData){
      try {
        const lz = window.LZString;
        const json = lz.decompressFromEncodedURIComponent(compressedData);
        if (json) {
          await openImportModal();
          await handleImportPayload(json);
        }
      } catch(err) {
        console.error('Failed to decompress shared recipe:', err);
        alert('Не удалось загрузить рецепт по ссылке');
      }
    }

    function wireLaunchQueue(){
      if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (launchParams) => {
          if (launchParams.files && launchParams.files.length > 0) {
            // Automatically open import modal if files are present
            await openImportModal();
            for (const fileHandle of launchParams.files) {
              const file = await fileHandle.getFile();
              await handleFileImport(file);
            }
          }
        });
      }
    }

    async function main(){
      window.openAddMealModal = openAddMealModal;
      window.openAddActivityModal = openAddActivityModal;
      window.openRecipeBuilder = openRecipeBuilder;
      window.currentFoodType = currentFoodType;

      initHistory();
      wireClassificationModal();
      wireTabsAndEditors();
      wirePortionModal();
      wireRecipeBuilder();
      wireShareModal();
      wireImportModal();
      wireLaunchQueue();
      wireFab();
      wireModalButtons();
      wireBarcodeSearch();
      wireAddButtons();
      wireDraftInputs();
      wireGlobalClicks();
      wireActivityInputs();
      wireAutoSelect();
      wireAutoScrollSearch();
      wireHeaderScore();
      wireRecipeScore();
      wireNotifications();
      wireSWMessages();
      await wireActions();
      await loadAll();
      await checkUrlForSharedRecipe();

      // Notification background loop (every 1 minute)
      setInterval(() => evaluateAllTriggers(), 60000);
      evaluateAllTriggers(); 
    }
    window.main = main;
function wireHeaderScore() {
  const container = document.getElementById("modalScoreContainer");
  if (!container) return;

  container.addEventListener("click", () => {
    if (container.querySelector("input")) return;

    const currentVal = window.modalCurrentScore;
    container.innerHTML = `<input type="number" step="0.1" style="width: 60px; font-size: 1em; padding: 2px;" id="headerScoreInput">`;
    const input = container.querySelector("input");
    input.value = currentVal;
    input.focus();

    const commit = () => {
      const newVal = parseFloat(input.value);
      if (!isNaN(newVal)) {
        window.modalCurrentScore = newVal;
      }
      renderHeaderScore(window.modalCurrentScore);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        input.blur();
      }
    });
  });
}
window.wireHeaderScore = wireHeaderScore;

function wireRecipeScore() {
  const container = document.getElementById("recipeScoreContainer");
  if (!container) return;

  container.addEventListener("click", () => {
    if (container.querySelector("input")) return;

    // Use recipe-specific score state
    const currentVal = window.recipeCurrentScore;
    container.innerHTML = `<input type="number" step="0.1" style="width: 60px; font-size: 1em; padding: 2px;" id="recipeHeaderScoreInput">`;
    const input = container.querySelector("input");
    input.value = currentVal;
    input.focus();

    const commit = () => {
      const newVal = parseFloat(input.value);
      if (!isNaN(newVal)) {
        window.recipeCurrentScore = newVal;
      }
      renderHeaderScore(window.recipeCurrentScore, "recipeScoreContainer");
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        input.blur();
      }
    });
  });
}
window.wireRecipeScore = wireRecipeScore;

async function wireNotifications() {
  const btn = document.getElementById("btnToggleNotifications");
  if (!btn) return;

  const updateUI = () => {
    if (!("Notification" in window)) {
      btn.textContent = "Не поддерживается";
      btn.disabled = true;
      return;
    }
    if (Notification.permission === "granted") {
      btn.textContent = "Включены (OK)";
    } else if (Notification.permission === "denied") {
      btn.textContent = "Заблокированы";
      btn.disabled = true;
    } else {
      btn.textContent = "Включить уведомления";
    }
  };

  btn.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    try {
      const permission = await Notification.requestPermission();
      updateUI();
      if (permission === "granted") {
        new Notification("TinyWife", { 
          body: "Уведомления успешно включены!", 
          icon: "icon-192.png" 
        });
      }
    } catch (err) {
      console.error("Permission request failed", err);
    }
  });

  updateUI();
}

function wireAutoSelect() {
  document.addEventListener("focusin", (e) => {
    if (e.target && e.target.tagName === "INPUT") {
      // Small timeout to ensure selection happens after browser default behavior
      setTimeout(() => {
        if (typeof e.target.select === "function") {
          e.target.select();
        }
      }, 50);
    }
  });
}

function wireAutoScrollSearch() {
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && (el.id === "foodSearch" || el.id === "actSearch")) {
      
      const executeScroll = () => {
        // Use native scrollIntoView with margin for better robustness
        el.style.scrollMarginTop = "20px";
        el.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      };

      if (!window.visualViewport) {
        setTimeout(executeScroll, 300);
        return;
      }

      // Logic for DVH/Keyboard
      let stabilizedTimer = null;
      let hasResized = false;
      
      const cleanup = () => {
         window.visualViewport.removeEventListener("resize", onResize);
         clearTimeout(stabilizedTimer);
         clearTimeout(fallbackTimer);
      };

      const onResize = () => {
        hasResized = true;
        clearTimeout(stabilizedTimer);
        // Wait for 150ms stability
        stabilizedTimer = setTimeout(() => {
           cleanup();
           executeScroll();
        }, 150); 
      };

      window.visualViewport.addEventListener("resize", onResize);

      // Fallback/Desktop: If no resize happens within X ms, just scroll.
      // Keyboard usually takes 300-500ms to show up.
      // We wait longer than the original 300ms to allow time for the resize to *start*.
      const fallbackTimer = setTimeout(() => {
        if (!hasResized) {
           cleanup();
           executeScroll();
        }
      }, 600);
    }
  });
}

main();

async function propagateRecipeUpdate(recipeId){
  if(!recipeId) return;
  const parents = (window.meals || []).filter(m => 
    m.type === "recipe" && 
    m.ingredients && 
    m.ingredients.some(ing => ing.mealId === recipeId)
  );

  for(const p of parents){
    const totals = calculateRecipeTotals(p.ingredients);
    const weightCoeff = p.weightCoefficient || 1.0;
    const cookedWeight = totals.weight * weightCoeff;
    const divisor = (cookedWeight || 100) / 100;

    p.calories = Math.round(totals.calories / divisor);
    p.proteinG = parseFloat((totals.proteinG / divisor).toFixed(1));
    p.fluidMl = parseFloat((totals.fluidMl / divisor).toFixed(1));
    p.portionG = cookedWeight;
    p.updatedAt = new Date().toISOString();
    
    await txPut("meals", p);
    // Recurse up the chain
    await propagateRecipeUpdate(p.id);
  }
}

// Exports for tests and console use
window.searchFood = searchFood;
window.searchFoodUSDA = searchFoodUSDA;
window.getMealById = getMealById;
window.getRecipeDependencies = getRecipeDependencies;
    window.serializeBundle = serializeBundle;
    window.compressPayload = compressPayload;
    window.decompressPayload = decompressPayload;
    window.parseBundle = parseBundle;
    window.analyzeImport = analyzeImport;window.executeImport = executeImport;
window.ResolutionState = ResolutionState;
window.openShareModal = openShareModal;
window.openImportModal = openImportModal;







window.buildMealSnapshot = buildMealSnapshot;
window.addMealToToday = addMealToToday;
window.scaleMealNutrients = scaleMealNutrients;
window.calculateRecipeTotals = calculateRecipeTotals;
window.detectRecipeLoop = detectRecipeLoop;
window.propagateRecipeUpdate = propagateRecipeUpdate;
window.wireRecipeBuilder = wireRecipeBuilder;
window.openRecipeBuilder = openRecipeBuilder;
window.handleRecipeEatNow = handleRecipeEatNow;
window.handleRecipeSave = handleRecipeSave;
window.openPortionModal = openPortionModal;
window.openAddMealModal = openAddMealModal;
window.openAddActivityModal = openAddActivityModal;
window.incrementUsageScore = incrementUsageScore;
window.applyGlobalDecay = applyGlobalDecay;
window.currentFoodType = window.currentFoodType || currentFoodType;
window.saveDraft = saveDraft;
window.setStatus = setStatus;
window.txPut = txPut;
window.txGetAll = txGetAll;
window.meals = window.meals || [];
window.todayMealEntries = window.todayMealEntries || [];
window.activities = window.activities || [];
window.todayActivityEntries = window.todayActivityEntries || [];
window.recipeComponents = window.recipeComponents || [];

function visualFeedback(el){
  if(!el) return;
  el.classList.remove("pulse-save");
  void el.offsetWidth; // trigger reflow
  el.classList.add("pulse-save");
  setTimeout(() => el.classList.remove("pulse-save"), 600);
}

function triggerHaptic(){
  if(window.navigator && window.navigator.vibrate){
    window.navigator.vibrate(15);
  }
}
window.triggerHaptic = triggerHaptic;

    function checkScannerSupport() {
      return typeof window.BarcodeDetector !== 'undefined';
    }
    window.checkScannerSupport = checkScannerSupport;

    
