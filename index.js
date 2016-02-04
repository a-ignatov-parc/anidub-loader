import fs from 'fs';
import vm from 'vm';
import path from 'path';

import merge from 'merge';
import mkdirp from 'mkdirp';
import cheerio from 'cheerio';
import request from 'request';
import Promise from 'bluebird';
import through from 'through2';
import sanitize from 'sanitize-filename';
import expandHomeDir from 'expand-home-dir';

import ProgressBar from 'progress';
import Downloader, {Formatters} from 'mt-files-downloader';

const mkdir = Promise.promisify(mkdirp);
const fsStat = Promise.promisify(fs.stat);

const formatRegex = /^mp4_(\d{3,4})$/;

const defaults = {
	'page': '',
	'title': '',
	'season': 1,
	'episodes': '',
	'plex-path': './',
};

const ctx = process.argv.slice(2).reduce((result, param) => {
	let [key, value] = param.split('=');
	value && (result[key] = value);
	return result;
}, defaults);

ctx.range = Array.prototype.concat.apply([], ctx.episodes
	.split(/\s*,\s*/)
	.filter(Boolean)
	.map((item) => {
		return item
			.split(/\s*-+\s*/)
			.filter(Boolean)
			.map((item) => +item)
			.filter(Boolean)
			.sort(ascendant)
			.slice(0, 2)
			.reduce((start, end) => {
				let result = [];
				while(start <= end) result.push(start++);
				return result;
			});
	}));

let startTime = Date.now();

load(ctx.page, 'TV Series home page')
	.then((body) => {
		let $ = cheerio.load(body);
		return {
			pageTitle: $('.titlfull').text(),
			links: $('#video_vk option').map((i, el) => $(el).attr('value')).get(),
		};
	})
	.then(({pageTitle, links}) => {
		let {season, title} = parsePageInfo(pageTitle);
		merge(ctx, {season, title});
		return links.map((link) => {
			let [rawParams, episode] = link.split('?')[1].split('|');
			let params = parseParams(rawParams);
			return {rawParams, params, episode: +episode};
		});
	})
	.then((episodes) => {
		let requests = episodes
			.filter(({episode}) => !ctx.range.length || ~ctx.range.indexOf(episode))
			.map((payload) => {
				let {params, episode} = payload;
				let {oid, id} = params;

				return load(
					`http://lidplay.net/video_ext.php?oid=${oid}&id=${id}`,
					`hosting page for "Episode ${formatNum(episode)}"`
				).then((body) => merge({}, payload, {body}));
			});

		return Promise.all(requests);
	})
	.then((episodes) => episodes.map((payload) => {
		let $ = cheerio.load(payload.body);
		let scriptContent = $('script').first().text();
		let sandbox = {};
		let context = new vm.createContext(sandbox);
		let script = new vm.Script(scriptContent);

		script.runInContext(context);
		return merge({}, payload, {api: sandbox.params});
	}))
	.then((episodes) => Promise.all(episodes.map((payload) => {
		let {
			episode,
			api: {
				sig,
				videos,
				callback,
				access_token,
			},
		} = payload;

		return post(
			`https://api.vk.com/method/video.get`,
			{videos, access_token, sig},
			`vk.com api for "Episode ${formatNum(episode)}" video info`
		)
		.then((stringPayload) => {
			let result;

			try {
				result = JSON.parse(stringPayload);
			} catch(e) {}

			return result && result.response[1].files;
		})
		.then((videosParams) => {
			let files = {};

			if (videosParams) {
				files = Object
					.keys(videosParams)
					.filter((key) => formatRegex.test(key))
					.reduce((result, key) => {
						result[key.replace(formatRegex, '$1')] = videosParams[key];
						return result;
					}, {});
			}

			return merge({}, payload, {files});
		});
	})))
	.then((episodes) => episodes.map((payload) => {
		let {episode, files} = payload;
		let {quality, url} = chooseBestQuality(files);

		if (quality) {
			console.log(`Selected video quality for "Episode ${formatNum(episode)}": ${quality}`);
		} else {
			console.log(`Unable to detect video quality for "Episode ${formatNum(episode)}"`);
		}
		return merge({}, payload, {quality, video: url});
	}))
	.then((episodes) => {
		let {
			title,
			season,
			'plex-path': plexPath
		} = ctx;

		let targetPath = path.join(plexPath, sanitize(title), `Season ${formatNum(season)}`);
		let params = episodes.map(({video, episode}) => {
			return [video, `${title} - s${formatNum(season)}e${formatNum(episode)}.mp4`, targetPath];
		});

		return chainDownload(params);
	})
	.then(() => {
		let endTime = Date.now();
		console.log(`All done in ${Formatters.remainingTime(~~((endTime - startTime) / 1000))}`);
	});

function load(url, description) {
	return new Promise((resolve, reject) => {
		let progress = new ProgressBar(`Requesting ${description || `"${url}"`}... :bar`, {
			incomplete: '',
			complete: '✔︎',
			total: 1,
		});

		request(url, (err, response, body) => {
			if (err) {
				progress.terminate();
				return reject(err);
			}
			progress.tick();
			resolve(body);
		});
	});
}

function post(url, form, description) {
	return new Promise((resolve, reject) => {
		let progress = new ProgressBar(`Making POST request to ${description || `"${url}"`}... :bar`, {
			incomplete: '',
			complete: '✔︎',
			total: 1,
		});

		request.post({url, form}, (err, response, body) => {
			if (err) {
				progress.terminate();
				return reject(err);
			}
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

const pageInfoRegex = /(?:тв-(\d+))?\s*\/\s*(?:(.*)(?:tv-\d+)|(.*)\s*\[)/i;

function parsePageInfo(rawString = '') {
	let [, season, title1, title2] = rawString.match(pageInfoRegex);

	return {
		season: +(season || ctx.season),
		title: (ctx.title || title2 || title1 || '').trim(),
	};
}

function chooseBestQuality(params) {
	let quality = Object.keys(params).sort(descendant).filter((quality, i) => !i)[0];
	let url = params[quality];
	return {quality, url};
}

function createProgressBar(description = 'Loading', total = 1) {
	console.log(description);
	return new ProgressBar(`[:bar] :percent`, {
		incomplete: ' ',
		complete: '=',
		width: 80,
		total
	});
}

function downloadFile(url, name, targetPath) {
	let absoluteTargetPath = path.resolve(expandHomeDir(targetPath));
	let pathname = path.join(absoluteTargetPath, name);

	if (!url) {
		console.log(`Unable to resolve video url for "${name}". Skipping...`);
		return Promise.resolve();
	}

	return mkdir(absoluteTargetPath).then(() => {
		let downloader = new Downloader();

		return fsStat(`${pathname}.mtd`)
			.then(() => {
				console.log(`Preparing to resume download of "${name}"...`);
				return downloader.resumeDownload(pathname);
			}, () => {
				console.log(`Preparing to download "${name}" from "${url}"...`);
				return downloader.download(url, pathname);
			})
			.then((download) => download.setOptions({
				threadsCount: 16
			}))
			.then((download) => new Promise((resolve, reject) => {
				let progress;
				let checker;
				let stats;

				download
					.on('start', () => {
						let initialStats = download.getStats();
						progress = createProgressBar(`Downloading "${name.split('.')[0]}"`, initialStats.total.size);
						checker = setInterval(() => {
							stats = download.getStats();
							progress.update((stats.total.completed / 100) - .01);
						}, 100);
					})
					.on('end', () => {
						checker && clearInterval(checker);
						progress.update(1);
						progress.terminate();
						resolve(download.getStats());
					})
					.on('error', (err) => {
						console.log(err);
						checker && clearInterval(checker);
						progress.terminate();
						resolve(download.getStats());
						download.destroy();
					})
					.start();
			}));
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

function ascendant(a, b) {
	return a - b;
}

function descendant(a, b) {
	return b - a;
}
