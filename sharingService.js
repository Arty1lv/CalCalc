/**
 * Sharing Service v10 - Optimized for Native Share Sheet
 * Ensures synchronous execution to satisfy Transient Activation requirements.
 */

/**
 * Generates a shareable URL containing compressed recipe data.
 * Synchronous to avoid breaking user gesture.
 */
function generateShareLinkSync(rootRecipe, items) {
  if (!rootRecipe || !items || !window.LZString) return null;

  const payload = {
    v: 2,
    root: rootRecipe.id,
    items: items
  };

  const compressed = window.LZString.compressToEncodedURIComponent(JSON.stringify(payload));
  const baseUrl = window.location.origin + window.location.pathname;
  return `${baseUrl}?recipe=${compressed}`;
}

/**
 * Triggers the OS share sheet with the recipe link.
 * MUST be called synchronously within a click handler.
 */
function shareRecipeLink(rootRecipe, items) {
  const url = generateShareLinkSync(rootRecipe, items);
  if (!url) return;

  const shareData = {
    title: `Рецепт: ${rootRecipe.name}`,
    text: `Посмотри этот рецепт: ${rootRecipe.name}`,
    url: url
  };

  if (navigator.share) {
    navigator.share(shareData).catch(err => {
      if (err.name !== 'AbortError') {
        console.error('Share failed:', err);
        copyToClipboard(url); // Fallback on error
      }
    });
  } else {
    copyToClipboard(url);
  }
}

/**
 * Helper to copy text to clipboard.
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    if (window.setStatus) window.setStatus("Ссылка скопирована в буфер обмена");
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }
}

// Export to window
window.generateShareLinkSync = generateShareLinkSync;
window.shareRecipeLink = shareRecipeLink;
window.copyToClipboard = copyToClipboard;
