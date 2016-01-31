import fs from 'fs';
import path from 'path';

import mkdirp from 'mkdirp';
import cheerio from 'cheerio';
import request from 'request';
import Promise from 'bluebird';
import through from 'through2';
import expandHomeDir from 'expand-home-dir';

import ProgressBar from 'progress';

const mkdir = Promise.promisify(mkdirp);

let {'plex-path': plexPath = './', page, season = 1} = process.argv.slice(2).reduce((result, param) => {
	let [key, value] = param.split('=');
	result[key] = value;
	return result;
}, {});

const formatRegex = /^url(\d{3,4})$/;

load(page, 'TV Series home page')
	.then((body) => {
		let $ = cheerio.load(body);
		return {
			title: $('.titlfull').text(),
			links: $('#video_vk option').map((i, el) => $(el).attr('value')).get(),
		};
	})
	.then(({title, links}) => {
		return {
			title: parseTitle(title),
			links: links.map((link) => {
				let [rawParams, episode] = link.split('?')[1].split('|');
				let params = parseParams(rawParams);
				return {rawParams, params, episode};
			}),
		};
	})
	.then(({title, links}) => {
		let requests = links
			.map(({rawParams, episode}) => {
				return load(
					`http://vk.com/video_ext.php?${rawParams}`,
					`hosting page for Episode ${formatNum(episode)}`
				);
			});

		return Promise
			.all(requests)
			.then((results) => {
				return results.map((body) => {
					let $ = cheerio.load(body);
					return $('param[name="flashvars"]').attr('value');
				});
			})
			.then((params) => {
				return params
					.map(parseParams)
					.map((params) => {
						return Object
							.keys(params)
							.filter((key) => formatRegex.test(key))
							.reduce((result, key) => {
								result[key.replace(formatRegex, '$1')] = params[key];
								return result;
							}, {})
					});
			})
			.then((config) => {
				return config
					.map(chooseBestQuality)
					.map(({quality, url}, i) => {
						let {rawParams, params, episode} = links[i];

						if (quality) {
							console.log(`Selected video quality for Episode ${formatNum(episode)}: ${quality}`);
						} else {
							console.log(`Unable to detect video quality for Episode ${formatNum(episode)}`);
						}

						return {
							params,
							episode,
							quality,
							rawParams,
							video: url,
						};
					})
			})
			.then((links) => {
				return {title, links};
			})
	})
	.then(({title, links}) => {
		let targetPath = path.join(plexPath, title, `Season ${formatNum(season)}`);
		let params = links.map(({video, episode}) => {
			return [video, `${title} - s${formatNum(season)}e${formatNum(episode)}.mp4`, targetPath];
		});

		return chainDownload(params);
	})

function load(url, description) {
	return new Promise((resolve, reject) => {
		let progress = createProgressBar(`Requesting ${description || `"${url}"`}`);

		request(url, (err, response, body) => {
			if (err) return reject(err);
			progress.tick();
			resolve(body);
		});
	});
}

function parseParams(queryString = '') {
	return queryString
		.split('&')
		.reduce((result, param) => {
			let [key, ...value] = param.split('=');
			result[key] = value.join('');
			return result;
		}, {});
}

function parseTitle(rawString) {
	return rawString
		.trim()
		.replace(/^([^\/]+)\/([^\[]+)\[([^\]]+)\]$/, '$2')
		.trim();
}

function chooseBestQuality(params) {
	let quality = Object.keys(params).sort((a, b) => +b - +a).filter((quality, i) => !i)[0];
	let url = params[quality];
	return {quality, url};
}

function createProgressBar(description = 'Loading', total = 1) {
	return new ProgressBar(`${description} [:bar] :percent :etas`, {
		incomplete: ' ',
		complete: '=',
		width: 20,
		total
	});
}

function downloadFile(url, name, targetPath) {
	let absoluteTargetPath = path.resolve(expandHomeDir(targetPath));
	let pathname = path.join(absoluteTargetPath, name);
	let progress;
	let total;

	if (!url) {
		console.log(`Unable to resolve video url for "${name}". Skipping...`);
		return Promise.resolve();
	}

	return mkdir(absoluteTargetPath).then(() => {
		return new Promise((resolve, reject) => {
			request(url)
				.on('response', (response) => {
					total = +response.headers['content-length'];
					progress = createProgressBar(`Downloading "${name.split('.')[0]}"`, total);
				})
				.pipe(through(function(chunk, enc, next) {
					progress.tick(chunk.length);
					this.push(chunk);
					next();
				}))
				.pipe(fs.createWriteStream(pathname))
				.on('end', resolve)
				.on('error', reject)
		});
	});
}

function chainDownload(params) {
	let chain = Promise.resolve();

	params.forEach((args) => {
		chain = chain.then(deferredDownload(...args));
	});

	return chain;
}

function deferredDownload(...args) {
	return () => downloadFile(...args);
}

function formatNum(num) {
	return (`00${num}`).slice(-2);
}
