'use strict';

import {
	get as _get
} from 'https';
import {
	get as __get
} from 'http';

/**
 * Fetches a URL and returns the response body as a Buffer.
 * Follows HTTP 3xx redirects automatically.
 *
 * @param {string} url - The URL to fetch (http or https).
 * @returns {Promise<Buffer>} Resolves with the full response body.
 */
function fetch(url) {
	return new Promise((resolve, reject) => {
		const get = url.startsWith('https') ? _get : __get;
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
async function fetchText(url) {
	const b = await fetch(url);
	return b.toString('utf8');
}

export default {
	fetch,
	fetchText
};