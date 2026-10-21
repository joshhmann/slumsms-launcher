import path from 'node:path';

/**
 * Build channels. One launcher serves Live, Test and RC: each channel is a feed beside the Live one
 * (/manifest.json, /launcher-test/manifest.json, /launcher-rc/manifest.json) with its own game
 * folder, installed.json and launcher.json. Which channels a key opens is decided by the server's
 * basic auth: the launcher probes each channel's top-level manifest (200 = open, 401/403 = closed).
 * Probing needs no extra server endpoint and answers exactly the question the downloads will face.
 */
export const CHANNELS = Object.freeze([
  Object.freeze({ id: 'live', label: 'Live', prefix: '' }),
  Object.freeze({ id: 'test', label: 'Test', prefix: 'launcher-test/' }),
  Object.freeze({ id: 'rc', label: 'RC', prefix: 'launcher-rc/' }),
]);
export const CHANNEL_IDS = Object.freeze(CHANNELS.map(({ id }) => id));
export const channelLabel = (id) => CHANNELS.find((channel) => channel.id === id)?.label ?? 'Live';
export const isChannel = (id) => CHANNEL_IDS.includes(id);

/** Feed URL per channel, derived from the Live manifest URL. */
export function channelFeeds(liveFeedUrl) {
  const feeds = {};
  for (const { id, prefix } of CHANNELS) {
    feeds[id] = !liveFeedUrl ? '' : prefix ? new URL(`${prefix}${path.posix.basename(new URL(liveFeedUrl).pathname) || 'manifest.json'}`, liveFeedUrl).href : liveFeedUrl;
  }
  return feeds;
}

/** Which channel a feed URL is (for old settings that stored a raw URL), or null. */
export function channelOfFeed(feedUrl, liveFeedUrl) {
  if (!feedUrl || !liveFeedUrl) return null;
  let href;
  try { href = new URL(feedUrl).href; } catch { return null; }
  const feeds = channelFeeds(liveFeedUrl);
  return CHANNEL_IDS.find((id) => feeds[id] === href) ?? null;
}

/** Probe every channel's top-level manifest with the key. `check` is checkAvailableRelease. */
export async function probeChannels(feeds, { accessKey = '', check }) {
  const results = await Promise.all(CHANNEL_IDS.map((id) => (feeds[id] ? check(feeds[id], { accessKey }) : { status: 'error', message: 'No feed.' })));
  return Object.fromEntries(CHANNEL_IDS.map((id, index) => [id, results[index]]));
}

/** Channels this key opens. Live is always listed: it is every launcher's home. */
export function accessibleChannels(probes) {
  return CHANNEL_IDS.filter((id) => id === 'live' || probes?.[id]?.status === 'ok');
}

/** The channel picker exists only for keys that open more than one channel; players never see it. */
export const showChannelPicker = (probes) => accessibleChannels(probes).length > 1;

/**
 * The channel actually used. A non-Live choice stands while its probe is ok or merely unanswered
 * (offline, still checking); a refused or missing channel (401/403, 404, bad answer) falls back to Live.
 */
export function effectiveChannel(selected, probes) {
  if (!isChannel(selected) || selected === 'live') return 'live';
  const status = probes?.[selected]?.status;
  if (status === undefined || status === 'ok' || status === 'offline' || status === 'checking') return selected;
  return 'live';
}

/** Self-update follows the channel in use: a player's launcher only ever updates from Live's launcher.json. */
export function selfUpdateFeed({ selected, probes, liveFeedUrl }) {
  return channelFeeds(liveFeedUrl)[effectiveChannel(selected, probes)];
}

/**
 * The game folder for a channel. Live: the folder the player chose, else the launcher's bundled
 * client, else the per-user default (exactly where 1.3.2 and older installed). Test/RC: their own
 * chosen folder, else "<Live folder>-test" / "<Live folder>-rc" beside it. Nothing is created here;
 * an install creates its folder on first use.
 */
export function channelInstallDir(channel, { saved = {}, bundledDir = '', standaloneDir = '' }) {
  const liveDir = saved.live || bundledDir || standaloneDir;
  if (channel === 'live' || !isChannel(channel)) return liveDir;
  return saved[channel] || (liveDir ? `${liveDir.replace(/[\\/]+$/u, '')}-${channel}` : '');
}

const folderKey = (dir, platform) => {
  const resolved = path.resolve(dir).replace(/[\\/]+$/u, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The other channel already using `dir`, if any: two channels must never share a folder. */
export function folderOwner(dir, channel, dirs, platform = process.platform) {
  const key = folderKey(dir, platform);
  return CHANNEL_IDS.find((id) => id !== channel && dirs[id] && folderKey(dirs[id], platform) === key) ?? null;
}

/**
 * Which channel an existing game folder looks like, from its installed.json record and the manifests
 * the server offers now (`probes`): the exact manifest first, then the release name, then the name's
 * own hint ("-rc", "test"). null when the folder gives no signal.
 */
export function folderChannel(record, probes = {}) {
  if (!record) return null;
  const offered = (id) => (probes[id]?.status === 'ok' ? probes[id] : null);
  if (record.manifestSha256) {
    const exact = CHANNEL_IDS.find((id) => offered(id)?.manifestSha256 === record.manifestSha256);
    if (exact) return exact;
  }
  // Test and RC often carry the same release name as Live at a release; only a unique match counts.
  const byName = CHANNEL_IDS.filter((id) => offered(id)?.version === record.release);
  if (byName.length === 1) return byName[0];
  if (/(^|[^a-z])rc\d*($|[^a-z])/iu.test(record.release)) return 'rc';
  if (/test/iu.test(record.release)) return 'test';
  return null;
}

/**
 * Migrate the pre-1.3.3 shared settings.json ({ feedUrl, installDir, accessKey, pendingGameOptions })
 * into this install's per-channel settings. Never moves, copies or deletes a game folder.
 *   - feedUrl picks the channel (live / launcher-test / launcher-rc); another server stays the Live
 *     feed override.
 *   - installDir is kept only if it holds the game (`folder.holdsGame`). It becomes Live's folder only
 *     when every signal says Live; when the folder or the old feed point elsewhere, or disagree, the
 *     result carries a `question` for the player ("This folder looks like an RC install…") and the
 *     folder is left unassigned until answered (applyMigrationAnswer).
 * `folder` = { holdsGame, record } for legacy.installDir (null when there is none).
 */
export function migrateLegacySettings(legacy, { liveFeedUrl, folder, probes = {} }) {
  const value = legacy && typeof legacy === 'object' ? legacy : {};
  const feed = typeof value.feedUrl === 'string' ? value.feedUrl : '';
  const feedChannel = feed ? channelOfFeed(feed, liveFeedUrl) : 'live';
  const settings = {
    settingsVersion: 2,
    feedUrl: feed && !feedChannel ? feed : '',
    accessKey: typeof value.accessKey === 'string' ? value.accessKey : '',
    channel: feedChannel ?? 'live',
    folders: { live: '', test: '', rc: '' },
    pendingGameOptions: null,
  };
  const dir = typeof value.installDir === 'string' ? value.installDir : '';
  const notes = [];
  if (!dir) return { settings, question: null, notes };
  if (!folder?.holdsGame) {
    notes.push(`Old game folder ${dir} holds no game; Live keeps its default folder and ${dir} is left alone.`);
    return { settings, question: null, notes };
  }
  const fromFolder = folderChannel(folder.record, probes);
  const signals = [fromFolder, feedChannel ?? 'live'].filter(Boolean);
  if (signals.every((id) => id === 'live')) {
    settings.folders.live = dir;
    if (value.pendingGameOptions?.installDir === dir) settings.pendingGameOptions = value.pendingGameOptions;
    notes.push(`Old game folder ${dir} is the Live folder.`);
    return { settings, question: null, notes };
  }
  const suggested = fromFolder ?? feedChannel;
  const conflict = Boolean(fromFolder && feedChannel && fromFolder !== feedChannel);
  return {
    settings,
    notes,
    question: { dir, suggested, conflict, release: folder.record?.release ?? '',
      message: `This folder looks like ${suggested === 'rc' ? 'an' : 'a'} ${channelLabel(suggested)} install${folder.record?.release ? ` (${folder.record.release})` : ''}:\n${dir}\nUse it as the ${channelLabel(suggested)} folder?` },
  };
}

/** Apply the player's answer: `channel` takes the folder, or null leaves it alone. */
export function applyMigrationAnswer(settings, question, channel) {
  if (!question || !isChannel(channel)) return settings;
  return { ...settings, folders: { ...settings.folders, [channel]: question.dir } };
}

/** Read stored settings (version 2), dropping anything malformed. */
export function readSettings(value, { validKey = () => true } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const folders = { live: '', test: '', rc: '' };
  for (const id of CHANNEL_IDS) if (typeof raw.folders?.[id] === 'string') folders[id] = raw.folders[id];
  return {
    settingsVersion: 2,
    feedUrl: typeof raw.feedUrl === 'string' ? raw.feedUrl : '',
    accessKey: validKey(raw.accessKey) && typeof raw.accessKey === 'string' ? raw.accessKey : '',
    channel: isChannel(raw.channel) ? raw.channel : 'live',
    folders,
    pendingGameOptions: raw.pendingGameOptions ?? null,
  };
}
