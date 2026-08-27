'use strict';

const https = require('https');
const http = require('http');

/**
 * Fetches a URL and returns the response body as a Buffer.
 * Follows HTTP 3xx redirects automatically.
 *
 * @param {string} url - The URL to fetch (http or https).
 * @returns {Promise<Buffer>} Resolves with the full response body.
 */
function fetch(url) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : http.get;
        get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetch(res.headers.location).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

/**
 * Fetches a URL and returns the response body as a UTF-8 string.
 *
 * @param {string} url - The URL to fetch (http or https).
 * @returns {Promise<string>} Resolves with the full response body as text.
 */
function fetchText(url) { return fetch(url).then(b => b.toString('utf8')); }

module.exports = { fetch, fetchText };
