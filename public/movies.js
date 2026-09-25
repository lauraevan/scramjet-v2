
(() => {
	const TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlMWVmNjUwNjI1OTUyYzBkMjAzNThlYzUwYjQ4MjY5NiIsIm5iZiI6MTc3OTUwMDA3OS4zODIwMDAyLCJzdWIiOiI2YTExMDQyZjFiZTVlMDcyNTE2YjU3NmUiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.G2S8E4lZ8xdk1GJzkknjh_Z0DaHgaUKmk7kEUe0oCEU";
	const TMDB_API = "https://api.themoviedb.org/3";
	const TMDB_IMAGE = "https://image.tmdb.org/t/p/w500";
	const SYN_BASE = "https://synscraper-tffk.vercel.app";
	const HLS_SRC = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";

	let installed = false;
	let catalogLoaded = false;
	let currentMode = "trending";
	let currentDetail = null;
	let hlsInstance = null;
	let playerServer = null;
	let hlsPromise = null;

	const escapeHtml = (value) =>
		String(value ?? "")
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#039;");

	const titleOf = (item) =>
		item?.title ||
		item?.name ||
		item?.original_title ||
		item?.original_name ||
		"Untitled";

	const yearOf = (item) => {
		const date = item?.release_date || item?.first_air_date || "";
		return date ? String(date).slice(0, 4) : "—";
	};

	const mediaTypeOf = (item, fallback) => {
		if (item?.media_type === "movie" || item?.media_type === "tv") {
			return item.media_type;
		}
		return fallback || "movie";
	};

	const absoluteSynUrl = (value) => {
		if (!value) return "";
		return /^https?:\/\//i.test(value) ? value : SYN_BASE + value;
	};

	const formatTime = (seconds) => {
		if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
		const total = Math.floor(seconds);
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const secs = total % 60;
		return hours
			? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0")
			: minutes + ":" + String(secs).padStart(2, "0");
	};

	async function tmdb(path) {
		const response = await fetch(TMDB_API + path, {
			headers: {
				accept: "application/json",
				Authorization: "Bearer " + TMDB_TOKEN,
			},
		});
		if (!response.ok) {
			throw new Error("TMDB request failed (" + response.status + ")");
		}
		return response.json();
	}

	function loadHls() {
		if (window.Hls) return Promise.resolve(window.Hls);
		if (hlsPromise) return hlsPromise;
		hlsPromise = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = HLS_SRC;
			script.async = true;
			script.onload = () => resolve(window.Hls);
			script.onerror = () => reject(new Error("Failed to load HLS player"));
			document.head.appendChild(script);
		});
		return hlsPromise;
	}

	async function resolveMiami({ type, id, season, episode, title, year }) {
		const query = new URLSearchParams({
			type: String(type),
			id: String(id),
			provider: "vidy",
			mirror: "miami",
		});
		if (season != null) query.set("season", String(season));
		if (episode != null) query.set("episode", String(episode));
		if (title) query.set("title", String(title));
		if (year && year !== "—") query.set("year", String(year));

		const response = await fetch(SYN_BASE + "/api/streams?" + query.toString(), {
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error("Miami source request failed (" + response.status + ")");
		}
		const payload = await response.json();
		const servers = Array.isArray(payload?.servers) ? payload.servers : [];
		const miami = servers.filter((server) => {
			const provider = String(server?.provider || "").toLowerCase();
			const name = String(server?.name || "").toLowerCase();
			return provider === "vidy" && name.includes("miami");
		});
		if (!miami.length) {
			throw new Error("Miami did not return a playable source for this title.");
		}
		return miami;
	}

	function destroyPlayback(video) {
		if (hlsInstance) {
			try {
				hlsInstance.destroy();
			} catch {}
			hlsInstance = null;
		}
		playerServer = null;
		if (video) {
			try {
				video.pause();
			} catch {}
			video.removeAttribute("src");
			video.load();
			Array.from(video.querySelectorAll("track")).forEach((track) => track.remove());
		}
	}

	function pickMiamiServer(servers) {
		const score = (server) => {
			const q = String(server?.quality || "").toLowerCase();
			if (/^auto/.test(q)) return 100000;
			const m = q.match(/(2160|1440|1080|720|480|360)/);
			return m ? Number(m[1]) : 0;
		};
		return [...servers].sort((a, b) => score(b) - score(a))[0] || null;
	}

	function installMoviesTab() {
		if (installed) return true;

		const browserButton = Array.from(document.querySelectorAll(".tab-button")).find(
			(button) => button.textContent.trim() === "Browser"
		);
		const browserPanel = document.querySelector(".browser-panel");
		if (!browserButton || !browserPanel || !browserPanel.parentElement) return false;

		installed = true;

		const moviesButton = document.createElement("button");
		moviesButton.type = "button";
		moviesButton.className = "tab-button";
		moviesButton.textContent = "Movies";
		moviesButton.dataset.scramjetMovies = "true";
		browserButton.insertAdjacentElement("afterend", moviesButton);

		const panel = document.createElement("div");
		panel.id = "scramjet-movies-panel";
		panel.className = "tab-panel";
		panel.innerHTML = `
			<div class="sj-movies-toolbar">
				<div class="sj-movies-toolbar-title">
					<h2>Movies & Shows</h2>
					<p>TMDB catalog · Miami playback</p>
				</div>
				<form class="sj-movies-search" id="sj-movies-search">
					<input id="sj-movies-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search movies and TV shows" />
					<button class="sj-btn" type="submit">Search</button>
				</form>
			</div>

			<div class="sj-movies-catalog" id="sj-movies-catalog">
				<div class="sj-movies-tabs">
					<button class="sj-btn active" type="button" data-mode="trending">Trending</button>
					<button class="sj-btn" type="button" data-mode="movies">Movies</button>
					<button class="sj-btn" type="button" data-mode="tv">TV Shows</button>
				</div>
				<div class="sj-state" id="sj-catalog-state"></div>
				<div class="sj-movies-grid" id="sj-movies-grid"></div>
				<div class="sj-tmdb-credit">This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
			</div>

			<div class="sj-movies-detail" id="sj-movies-detail">
				<div class="sj-detail-toolbar">
					<button class="sj-btn" type="button" id="sj-detail-back">← Back</button>
				</div>
				<div class="sj-state" id="sj-detail-state"></div>
				<div class="sj-detail-layout" id="sj-detail-layout"></div>
			</div>

			<div class="sj-player-view" id="sj-player-view">
				<div class="sj-player-header">
					<button class="sj-btn" type="button" id="sj-player-back">← Back</button>
					<div class="sj-player-title">
						<strong id="sj-player-title">Player</strong>
						<small id="sj-player-subtitle"></small>
					</div>
					<span class="sj-provider-chip">Miami</span>
				</div>
				<div class="sj-player-stage" id="sj-player-stage">
					<video id="sj-player-video" playsinline crossorigin="anonymous"></video>
					<div class="sj-player-overlay visible" id="sj-player-overlay">
						<div class="sj-player-overlay-card">
							<strong id="sj-player-status-title">Ready</strong>
							<p id="sj-player-status-copy">Choose a title to begin.</p>
							<div class="sj-player-overlay-actions" id="sj-player-overlay-actions"></div>
						</div>
					</div>
				</div>
				<div class="sj-player-controls">
					<button class="sj-control-btn" type="button" id="sj-play-toggle">Play</button>
					<input class="sj-progress" id="sj-progress" type="range" min="0" max="1000" value="0" step="1" />
					<span class="sj-time" id="sj-time">0:00 / 0:00</span>
					<input class="sj-volume" id="sj-volume" type="range" min="0" max="1" value="1" step="0.05" aria-label="Volume" />
					<select class="sj-mini-select" id="sj-quality" aria-label="Quality">
						<option value="-1">Auto</option>
					</select>
					<select class="sj-mini-select sj-captions-select" id="sj-captions" aria-label="Captions">
						<option value="-1">Captions off</option>
					</select>
					<button class="sj-control-btn" type="button" id="sj-fullscreen">Full</button>
				</div>
			</div>
		`;

		browserPanel.insertAdjacentElement("afterend", panel);

		const catalog = panel.querySelector("#sj-movies-catalog");
		const detail = panel.querySelector("#sj-movies-detail");
		const detailLayout = panel.querySelector("#sj-detail-layout");
		const detailState = panel.querySelector("#sj-detail-state");
		const catalogState = panel.querySelector("#sj-catalog-state");
		const grid = panel.querySelector("#sj-movies-grid");
		const searchForm = panel.querySelector("#sj-movies-search");
		const searchInput = panel.querySelector("#sj-movies-search-input");
		const modeButtons = Array.from(panel.querySelectorAll("[data-mode]"));
		const player = panel.querySelector("#sj-player-view");
		const video = panel.querySelector("#sj-player-video");
		const playerTitle = panel.querySelector("#sj-player-title");
		const playerSubtitle = panel.querySelector("#sj-player-subtitle");
		const overlay = panel.querySelector("#sj-player-overlay");
		const overlayTitle = panel.querySelector("#sj-player-status-title");
		const overlayCopy = panel.querySelector("#sj-player-status-copy");
		const overlayActions = panel.querySelector("#sj-player-overlay-actions");
		const playToggle = panel.querySelector("#sj-play-toggle");
		const progress = panel.querySelector("#sj-progress");
		const timeLabel = panel.querySelector("#sj-time");
		const volume = panel.querySelector("#sj-volume");
		const quality = panel.querySelector("#sj-quality");
		const captions = panel.querySelector("#sj-captions");
		const fullscreen = panel.querySelector("#sj-fullscreen");

		const setCatalogState = (message) => {
			catalogState.textContent = message || "";
			catalogState.classList.toggle("visible", Boolean(message));
		};

		const setDetailState = (message) => {
			detailState.textContent = message || "";
			detailState.classList.toggle("visible", Boolean(message));
		};

		const setPlayerStatus = (title, copy, actions = []) => {
			overlayTitle.textContent = title || "";
			overlayCopy.textContent = copy || "";
			overlayActions.innerHTML = "";
			for (const action of actions) {
				const button = document.createElement("button");
				button.className = "sj-btn" + (action.primary ? " primary" : "");
				button.type = "button";
				button.textContent = action.label;
				button.addEventListener("click", action.run);
				overlayActions.appendChild(button);
			}
			overlay.classList.add("visible");
		};

		const hidePlayerStatus = () => overlay.classList.remove("visible");

		const showCatalog = () => {
			destroyPlayback(video);
			player.classList.remove("visible");
			detail.classList.remove("visible");
			catalog.classList.remove("hidden");
		};

		const showDetail = () => {
			destroyPlayback(video);
			player.classList.remove("visible");
			catalog.classList.add("hidden");
			detail.classList.add("visible");
		};

		const showPlayer = () => {
			catalog.classList.add("hidden");
			detail.classList.remove("visible");
			player.classList.add("visible");
		};

		const setMode = (mode) => {
			currentMode = mode;
			modeButtons.forEach((button) => {
				button.classList.toggle("active", button.dataset.mode === mode);
			});
		};

		const renderItems = (items, fallbackType) => {
			grid.innerHTML = "";
			const filtered = (items || []).filter((item) => {
				const type = mediaTypeOf(item, fallbackType);
				return (type === "movie" || type === "tv") && item?.id;
			});
			if (!filtered.length) {
				setCatalogState("No titles found.");
				return;
			}
			setCatalogState("");

			for (const item of filtered) {
				const type = mediaTypeOf(item, fallbackType);
				const card = document.createElement("article");
				card.className = "sj-media-card";
				card.tabIndex = 0;

				const poster = item.poster_path
					? '<img class="sj-media-poster" loading="lazy" src="' +
						TMDB_IMAGE +
						item.poster_path +
						'" alt="">'
					: '<div class="sj-media-poster-fallback">No poster available</div>';

				card.innerHTML =
					'<div class="sj-media-poster-wrap">' +
					poster +
					'<span class="sj-media-type">' +
					(type === "tv" ? "TV" : "Movie") +
					'</span></div>' +
					'<div class="sj-media-info"><div class="sj-media-name" title="' +
					escapeHtml(titleOf(item)) +
					'">' +
					escapeHtml(titleOf(item)) +
					'</div><div class="sj-media-meta"><span>' +
					escapeHtml(yearOf(item)) +
					'</span><span>★ ' +
					Number(item.vote_average || 0).toFixed(1) +
					"</span></div></div>";

				const open = () => openDetail(type, item.id);
				card.addEventListener("click", open);
				card.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open();
					}
				});
				grid.appendChild(card);
			}
		};

		async function loadMode(mode) {
			setMode(mode);
			grid.innerHTML = "";
			setCatalogState("Loading catalog…");
			try {
				if (mode === "trending") {
					const data = await tmdb("/trending/all/week?language=en-US");
					renderItems(data.results || []);
				} else if (mode === "movies") {
					const data = await tmdb("/movie/popular?language=en-US&page=1");
					renderItems(data.results || [], "movie");
				} else {
					const data = await tmdb("/tv/popular?language=en-US&page=1");
					renderItems(data.results || [], "tv");
				}
			} catch (error) {
				setCatalogState(error instanceof Error ? error.message : "Failed to load catalog.");
			}
		}

		async function search(query) {
			const value = String(query || "").trim();
			if (!value) {
				loadMode(currentMode);
				return;
			}
			modeButtons.forEach((button) => button.classList.remove("active"));
			grid.innerHTML = "";
			setCatalogState("Searching…");
			try {
				const data = await tmdb(
					"/search/multi?include_adult=false&language=en-US&page=1&query=" +
						encodeURIComponent(value)
				);
				renderItems(data.results || []);
			} catch (error) {
				setCatalogState(error instanceof Error ? error.message : "Search failed.");
			}
		}

		async function populateEpisodes(item, seasonNumber, episodeSelect) {
			episodeSelect.innerHTML = '<option value="">Loading…</option>';
			episodeSelect.disabled = true;
			try {
				const season = await tmdb(
					"/tv/" + item.id + "/season/" + seasonNumber + "?language=en-US"
				);
				const episodes = Array.isArray(season?.episodes) ? season.episodes : [];
				episodeSelect.innerHTML = "";
				for (const episode of episodes) {
					const option = document.createElement("option");
					option.value = String(episode.episode_number);
					option.textContent =
						"E" +
						episode.episode_number +
						" · " +
						(episode.name || "Episode " + episode.episode_number);
					episodeSelect.appendChild(option);
				}
				episodeSelect.disabled = !episodes.length;
			} catch {
				episodeSelect.innerHTML = '<option value="">Unavailable</option>';
				episodeSelect.disabled = true;
			}
		}

		async function openDetail(type, id) {
			catalog.classList.add("hidden");
			detail.classList.add("visible");
			player.classList.remove("visible");
			detailLayout.innerHTML = "";
			setDetailState("Loading details…");

			try {
				const item = await tmdb("/" + type + "/" + id + "?language=en-US");
				currentDetail = { type, item };
				setDetailState("");

				const poster = item.poster_path
					? '<img class="sj-detail-poster" src="' + TMDB_IMAGE + item.poster_path + '" alt="">'
					: '<div class="sj-detail-poster"></div>';

				const runtime =
					type === "movie" && item.runtime
						? item.runtime + " min"
						: type === "tv" && item.number_of_seasons
							? item.number_of_seasons +
								(item.number_of_seasons === 1 ? " season" : " seasons")
							: "";

				const genres = Array.isArray(item.genres)
					? item.genres.map((genre) => genre.name).join(", ")
					: "";

				detailLayout.innerHTML =
					"<div>" +
					poster +
					'</div><div class="sj-detail-body"><h2>' +
					escapeHtml(titleOf(item)) +
					'</h2><div class="sj-detail-meta"><span>' +
					(type === "tv" ? "TV Show" : "Movie") +
					"</span><span>" +
					escapeHtml(yearOf(item)) +
					"</span><span>★ " +
					Number(item.vote_average || 0).toFixed(1) +
					"</span>" +
					(runtime ? "<span>" + escapeHtml(runtime) + "</span>" : "") +
					(genres ? "<span>" + escapeHtml(genres) + "</span>" : "") +
					'</div><p>' +
					escapeHtml(item.overview || "No overview is available for this title.") +
					'</p><div class="sj-play-row" id="sj-play-row"></div></div>';

				const playRow = detailLayout.querySelector("#sj-play-row");

				if (type === "movie") {
					const play = document.createElement("button");
					play.className = "sj-btn primary";
					play.type = "button";
					play.textContent = "Play with Miami";
					play.addEventListener("click", () => {
						startPlayback({
							type: "movie",
							id: item.id,
							title: titleOf(item),
							year: yearOf(item),
						});
					});
					playRow.appendChild(play);
				} else {
					const seasons = (item.seasons || []).filter(
						(season) => Number(season.season_number) > 0
					);
					const seasonField = document.createElement("label");
					seasonField.className = "sj-field";
					seasonField.innerHTML =
						'<span>Season</span><select class="sj-select" id="sj-season-select"></select>';
					const episodeField = document.createElement("label");
					episodeField.className = "sj-field";
					episodeField.innerHTML =
						'<span>Episode</span><select class="sj-select" id="sj-episode-select"></select>';
					const play = document.createElement("button");
					play.className = "sj-btn primary";
					play.type = "button";
					play.textContent = "Play with Miami";

					playRow.appendChild(seasonField);
					playRow.appendChild(episodeField);
					playRow.appendChild(play);

					const seasonSelect = seasonField.querySelector("select");
					const episodeSelect = episodeField.querySelector("select");
					for (const season of seasons) {
						const option = document.createElement("option");
						option.value = String(season.season_number);
						option.textContent =
							"Season " +
							season.season_number +
							(season.episode_count ? " · " + season.episode_count + " eps" : "");
						seasonSelect.appendChild(option);
					}

					if (seasons.length) {
						await populateEpisodes(item, seasons[0].season_number, episodeSelect);
					} else {
						episodeSelect.innerHTML = '<option value="">Unavailable</option>';
					}

					seasonSelect.addEventListener("change", () => {
						populateEpisodes(item, Number(seasonSelect.value), episodeSelect);
					});

					play.addEventListener("click", () => {
						if (!seasonSelect.value || !episodeSelect.value) return;
						startPlayback({
							type: "tv",
							id: item.id,
							season: Number(seasonSelect.value),
							episode: Number(episodeSelect.value),
							title: titleOf(item),
							year: yearOf(item),
						});
					});
				}
			} catch (error) {
				setDetailState(error instanceof Error ? error.message : "Failed to load details.");
			}
		}

		function attachCaptions(server) {
			captions.innerHTML = '<option value="-1">Captions off</option>';
			Array.from(video.querySelectorAll("track")).forEach((track) => track.remove());
			const list = Array.isArray(server?.captions) ? server.captions : [];
			list.forEach((caption, index) => {
				const track = document.createElement("track");
				track.kind = "subtitles";
				track.label = caption.name || caption.lang || "Caption " + (index + 1);
				track.srclang = caption.lang || "und";
				track.src = absoluteSynUrl(caption.play_url);
				video.appendChild(track);

				const option = document.createElement("option");
				option.value = String(index);
				option.textContent = track.label;
				captions.appendChild(option);
			});
			captions.value = "-1";
		}

		function updateQualityMenu(levels) {
			quality.innerHTML = '<option value="-1">Auto</option>';
			(levels || [])
				.map((level, index) => ({ level, index }))
				.sort((a, b) => Number(b.level.height || 0) - Number(a.level.height || 0))
				.forEach(({ level, index }) => {
					const option = document.createElement("option");
					option.value = String(index);
					option.textContent = level.height
						? level.height + "p"
						: level.bitrate
							? Math.round(level.bitrate / 1000) + " kbps"
							: "Level " + (index + 1);
					quality.appendChild(option);
				});
			quality.value = "-1";
		}

		async function playServer(server) {
			destroyPlayback(video);
			playerServer = server;
			const url = absoluteSynUrl(server.play_url);
			attachCaptions(server);
			updateQualityMenu([]);

			if (server.type === "hls" || /\.m3u8(?:\?|$)/i.test(url)) {
				const Hls = await loadHls();
				if (Hls?.isSupported()) {
					const hls = new Hls({
						enableWorker: true,
						progressive: true,
						startFragPrefetch: true,
						maxBufferLength: 10,
						maxMaxBufferLength: 24,
						backBufferLength: 15,
						abrEwmaDefaultEstimate: 24_000_000,
						manifestLoadingTimeOut: 4500,
						manifestLoadingMaxRetry: 2,
						manifestLoadingRetryDelay: 120,
						levelLoadingTimeOut: 5500,
						levelLoadingMaxRetry: 2,
						levelLoadingRetryDelay: 120,
						fragLoadingTimeOut: 10000,
						fragLoadingMaxRetry: 3,
						fragLoadingRetryDelay: 120,
					});
					hlsInstance = hls;
					let networkRetries = 0;
					let mediaRetries = 0;

					hls.loadSource(url);
					hls.attachMedia(video);

					hls.on(Hls.Events.MANIFEST_PARSED, () => {
						updateQualityMenu(hls.levels || []);
						hidePlayerStatus();
						video.play().catch(() => {});
					});

					hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
						if (hls.autoLevelEnabled) quality.value = "-1";
						else quality.value = String(data.level);
					});

					hls.on(Hls.Events.ERROR, (_event, data) => {
						if (!data.fatal) return;
						if (
							data.type === Hls.ErrorTypes.NETWORK_ERROR &&
							networkRetries < 2
						) {
							networkRetries += 1;
							window.setTimeout(() => {
								if (hlsInstance !== hls) return;
								if (
									data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
									data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
								) {
									hls.loadSource(url);
								} else {
									hls.startLoad();
								}
							}, 300 * networkRetries);
							return;
						}
						if (
							data.type === Hls.ErrorTypes.MEDIA_ERROR &&
							mediaRetries < 1
						) {
							mediaRetries += 1;
							hls.recoverMediaError();
							return;
						}
						setPlayerStatus(
							"Playback failed",
							"Miami returned a source, but the stream could not continue.",
							[
								{
									label: "Retry",
									primary: true,
									run: () => playServer(server),
								},
							]
						);
					});
					return;
				}
			}

			if (video.canPlayType("application/vnd.apple.mpegurl") || server.type !== "hls") {
				video.src = url;
				video.addEventListener(
					"loadedmetadata",
					() => {
						hidePlayerStatus();
						video.play().catch(() => {});
					},
					{ once: true }
				);
				return;
			}

			throw new Error("This browser cannot play the Miami stream format.");
		}

		async function startPlayback(info) {
			showPlayer();
			playerTitle.textContent = info.title || "Player";
			playerSubtitle.textContent =
				info.type === "tv"
					? "Season " + info.season + " · Episode " + info.episode
					: yearOf({ release_date: info.year ? info.year + "-01-01" : "" });
			setPlayerStatus(
				"Finding Miami source",
				"Checking the Miami provider and preparing the stream."
			);

			try {
				const servers = await resolveMiami(info);
				const server = pickMiamiServer(servers);
				if (!server) throw new Error("Miami did not return a playable source.");
				await playServer(server);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Miami could not load this title.";
				setPlayerStatus("Couldn't load this stream", message, [
					{
						label: "Retry",
						primary: true,
						run: () => startPlayback(info),
					},
					{
						label: "Back",
						run: showDetail,
					},
				]);
			}
		}

		playToggle.addEventListener("click", () => {
			if (video.paused) video.play().catch(() => {});
			else video.pause();
		});

		video.addEventListener("play", () => {
			playToggle.textContent = "Pause";
		});
		video.addEventListener("pause", () => {
			playToggle.textContent = "Play";
		});
		video.addEventListener("waiting", () => {
			if (!overlay.classList.contains("visible")) {
				setPlayerStatus("Buffering", "Miami is loading the next part of the stream.");
			}
		});
		video.addEventListener("playing", () => {
			hidePlayerStatus();
		});
		video.addEventListener("timeupdate", () => {
			if (Number.isFinite(video.duration) && video.duration > 0) {
				progress.value = String(Math.round((video.currentTime / video.duration) * 1000));
			}
			timeLabel.textContent =
				formatTime(video.currentTime) + " / " + formatTime(video.duration);
		});
		video.addEventListener("durationchange", () => {
			timeLabel.textContent =
				formatTime(video.currentTime) + " / " + formatTime(video.duration);
		});

		progress.addEventListener("input", () => {
			if (!Number.isFinite(video.duration) || video.duration <= 0) return;
			video.currentTime = (Number(progress.value) / 1000) * video.duration;
		});

		volume.addEventListener("input", () => {
			video.volume = Number(volume.value);
		});

		quality.addEventListener("change", () => {
			if (!hlsInstance) return;
			const value = Number(quality.value);
			hlsInstance.currentLevel = value;
			hlsInstance.nextLevel = value;
		});

		captions.addEventListener("change", () => {
			const selected = Number(captions.value);
			Array.from(video.textTracks || []).forEach((track, index) => {
				track.mode = index === selected ? "showing" : "disabled";
			});
		});

		fullscreen.addEventListener("click", () => {
			const stage = panel.querySelector("#sj-player-stage");
			if (!document.fullscreenElement) {
				stage.requestFullscreen?.();
			} else {
				document.exitFullscreen?.();
			}
		});

		panel.querySelector("#sj-detail-back").addEventListener("click", showCatalog);
		panel.querySelector("#sj-player-back").addEventListener("click", showDetail);

		modeButtons.forEach((button) => {
			button.addEventListener("click", () => {
				searchInput.value = "";
				loadMode(button.dataset.mode);
			});
		});

		searchForm.addEventListener("submit", (event) => {
			event.preventDefault();
			search(searchInput.value);
		});

		const originalButtons = Array.from(document.querySelectorAll(".tab-button")).filter(
			(button) => button !== moviesButton
		);

		const closeMovies = () => {
			document.body.classList.remove("scramjet-movies-active");
			panel.classList.remove("active");
			moviesButton.classList.remove("active");
			destroyPlayback(video);
		};

		for (const button of originalButtons) {
			button.addEventListener("click", closeMovies, true);
		}

		moviesButton.addEventListener("click", () => {
			for (const button of originalButtons) button.classList.remove("active");
			moviesButton.classList.add("active");
			document.body.classList.add("scramjet-movies-active");
			panel.classList.add("active");

			if (!catalogLoaded) {
				catalogLoaded = true;
				loadMode("trending");
			}
		});

		return true;
	}

	if (!installMoviesTab()) {
		const observer = new MutationObserver(() => {
			if (installMoviesTab()) observer.disconnect();
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	}
})();
