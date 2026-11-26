/**
 * qr.js - QR Code Generation Utility
 * ==============================================================================
 * Generates high-contrast, scan-optimized QR codes for physical computer tiles.
 * Loads the pinned QRCode ES module from CDN with graceful fallback.
 * ==============================================================================
 */

import { CONFIG } from './config.js';

let qrCodeLib = null;

/**
 * Dynamically import pinned QRCode library
 */
async function loadQRLib() {
  if (qrCodeLib) return qrCodeLib;
  try {
    const mod = await import(CONFIG.QRCODE_SDK_CDN);
    qrCodeLib = mod.default || mod;
    return qrCodeLib;
  } catch (err) {
    console.error('Failed to load QR code library from CDN:', err);
    throw new Error('QR library unavailable. Please check your network connection.');
  }
}

/**
 * Generate a QR code as a Data URL (PNG)
 * @param {string} text - URL or text to encode
 * @param {object} options - QRCode options
 * @returns {Promise<string>}
 */
export async function generateQRDataUrl(text, options = {}) {
  const lib = await loadQRLib();
  const defaultOpts = {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 2,
    width: 200,
    color: {
      dark: '#000000',
      light: '#ffffff'
    },
    ...options
  };

  return new Promise((resolve, reject) => {
    lib.toDataURL(text, defaultOpts, (err, url) => {
      if (err) return reject(err);
      resolve(url);
    });
  });
}

/**
 * Generate a QR code directly onto an HTML Canvas element
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {object} options
 */
export async function renderQRToCanvas(canvas, text, options = {}) {
  const lib = await loadQRLib();
  const defaultOpts = {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: options.width || 180,
    color: {
      dark: '#111111',
      light: '#ffffff'
    },
    ...options
  };

  return new Promise((resolve, reject) => {
    lib.toCanvas(canvas, text, defaultOpts, (err) => {
      if (err) return reject(err);
      resolve(canvas);
    });
  });
}

/**
 * Build the deep-link URL for a computer
 * @param {string} labSlugOrId
 * @param {number|string} pcNumber
 * @returns {string}
 */
export function buildComputerDeepLink(labSlugOrId, pcNumber) {
  const baseUrl = window.location.origin + window.location.pathname.replace(/\/admin\.html$/, '/index.html').replace(/\/$/, '/index.html');
  const cleanBase = baseUrl.endsWith('/index.html') ? baseUrl : baseUrl + '/index.html';
  const url = new URL(cleanBase);
  url.searchParams.set('lab', labSlugOrId);
  url.searchParams.set('pc', pcNumber);
  return url.toString();
}
