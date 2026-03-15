/**
 * Drisa_AI Widget Embed Script
 * This script allows you to embed the Drisa_AI agent into any website.
 */
(function() {
  // Configuration
  const scriptTag = document.currentScript;
  const baseUrl = scriptTag.src.replace('/embed.js', '');
  const mode = scriptTag.getAttribute('data-mode') || 'widget';
  const containerId = scriptTag.getAttribute('data-container');
  const position = scriptTag.getAttribute('data-position') || 'bottom-right';
  
  const iframeUrl = `${baseUrl}?mode=${mode}`;
  
  // Create Iframe
  const iframe = document.createElement('iframe');
  iframe.src = iframeUrl;
  iframe.style.border = 'none';
  iframe.style.overflow = 'hidden';
  iframe.style.zIndex = '999999';
  iframe.setAttribute('allow', 'microphone; camera; geolocation');

  if (containerId) {
    // Inline Mode: Place inside a specific container
    const container = document.getElementById(containerId);
    if (container) {
      iframe.style.width = '100%';
      iframe.style.height = '600px';
      container.appendChild(iframe);
    }
  } else {
    // Floating Widget Mode
    iframe.style.position = 'fixed';
    iframe.style.width = '420px';
    iframe.style.height = '650px';
    iframe.style.bottom = '20px';
    iframe.style.right = '20px';
    iframe.style.borderRadius = '16px';
    iframe.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
    
    // Handle positions
    if (position === 'bottom-left') {
      iframe.style.right = 'auto';
      iframe.style.left = '20px';
    } else if (position === 'top-right') {
      iframe.style.bottom = 'auto';
      iframe.style.top = '20px';
    } else if (position === 'top-left') {
      iframe.style.bottom = 'auto';
      iframe.style.right = 'auto';
      iframe.style.top = '20px';
      iframe.style.left = '20px';
    }

    document.body.appendChild(iframe);
  }
})();
