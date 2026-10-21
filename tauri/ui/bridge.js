// The launcher bridge for the Tauri build: the same `window.launcher` API the Electron preload
// exposed, backed by Tauri commands and the "launcher:state" event. The page never sees the access
// key; commands return only settings the page may show.
(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) return;
  const call = (command) => async (value) => {
    try {
      return await tauri.core.invoke(command, value === undefined ? {} : { value });
    } catch (error) {
      throw new Error(typeof error === 'string' ? error : error?.message ?? String(error));
    }
  };
  const commands = {
    settings: 'settings', saveFeed: 'save_feed', resetFeed: 'reset_feed', saveAccessKey: 'save_access_key', clearAccessKey: 'clear_access_key',
    chooseFolder: 'choose_folder', openFolder: 'open_folder', resetFolder: 'reset_folder', check: 'check', update: 'update', repair: 'repair', play: 'play',
    gameOptions: 'game_options', saveGameOptions: 'save_game_options', resetGameOptions: 'reset_game_options', setChannel: 'set_channel', answerMigration: 'answer_migration',
  };
  const launcher = Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, call(command)]));
  launcher.onState = (callback) => {
    let stop = null;
    let stopped = false;
    tauri.event.listen('launcher:state', (event) => callback(event.payload)).then((unlisten) => {
      if (stopped) unlisten(); else stop = unlisten;
    });
    return () => { stopped = true; stop?.(); };
  };
  Object.defineProperty(window, 'launcher', { value: Object.freeze(launcher), writable: false, configurable: false });
})();
