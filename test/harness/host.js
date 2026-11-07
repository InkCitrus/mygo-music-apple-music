/**
 * Mock Host Environment for MyGo Music Apple Music Plugin
 * Conforms to MyGo Music engine host specifications.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MockHost {
  constructor(options = {}) {
    this.platform = options.platform || "darwin";
    this.arch = options.arch || "arm64";
    this.dir = options.dir || path.resolve(__dirname, "../../");
    this.dataDir = options.dataDir || path.resolve(__dirname, "../../.test_data");

    // Internal state
    this._storageMap = new Map();
    this._settingsMap = new Map();
    this._currentLanguage = options.language || "en";
    this._translations = options.translations || {};
    this._openedURLs = [];
    this._webSignInBehavior = null;
    this._spawnBehavior = null;
    this._spawnHistory = [];
    this._processGranted = options.processGranted !== false;

    // Build host.storage object
    this.storage = {
      get: async (key) => {
        if (!this._storageMap.has(key)) return undefined;
        // Deep clone to prevent direct object reference mutation
        const raw = this._storageMap.get(key);
        return raw !== undefined ? JSON.parse(JSON.stringify(raw)) : undefined;
      },
      set: async (key, value) => {
        if (value === undefined) {
          this._storageMap.delete(key);
        } else {
          this._storageMap.set(key, JSON.parse(JSON.stringify(value)));
        }
      },
      remove: async (key) => {
        this._storageMap.delete(key);
      },
      // Test helper
      _reset: () => {
        this._storageMap.clear();
      },
      _dump: () => {
        const out = {};
        for (const [k, v] of this._storageMap.entries()) {
          out[k] = v;
        }
        return out;
      },
    };
  }

  setting(key) {
    return this._settingsMap.get(key) || "";
  }

  _setSetting(key, value) {
    if (value === undefined || value === null) {
      this._settingsMap.delete(key);
    } else {
      this._settingsMap.set(key, String(value));
    }
  }

  language() {
    return this._currentLanguage;
  }

  _setLanguage(lang) {
    this._currentLanguage = lang;
  }

  t(text) {
    if (this._currentLanguage === "zh-CN" && this._translations[text]) {
      return this._translations[text];
    }
    return text;
  }

  _setTranslations(translations) {
    this._translations = { ...translations };
  }

  openURL(url) {
    if (typeof url !== "string") {
      throw new Error(`not a web address: ${url}`);
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error(`not a web address: ${url}`);
    }
    this._openedURLs.push(url);
  }

  _getOpenedURLs() {
    return [...this._openedURLs];
  }

  async webSignIn(options) {
    if (!options || typeof options !== "object") {
      throw new Error("options object required for webSignIn");
    }
    const { url, cookiesOf, until, userAgent } = options;

    if (!url || !url.startsWith("https://")) {
      throw new Error("not a secure web address to sign in on");
    }
    if (!cookiesOf || !cookiesOf.startsWith("https://")) {
      throw new Error("not a secure web address for cookies");
    }
    if (!Array.isArray(until) || until.length === 0) {
      throw new Error("until parameter must be an array of cookie names");
    }

    if (this._webSignInBehavior) {
      if (typeof this._webSignInBehavior === "function") {
        return this._webSignInBehavior(options);
      }
      if (this._webSignInBehavior instanceof Error) {
        throw this._webSignInBehavior;
      }
      return this._webSignInBehavior;
    }

    // Default successful subscriber webSignIn simulation
    return {
      cookie: "media-user-token=mock_mut_subscriber_jwt_token_2026; itua=us; itspod=1",
    };
  }

  _setWebSignInBehavior(behavior) {
    this._webSignInBehavior = behavior;
  }

  _setProcessGranted(granted) {
    this._processGranted = Boolean(granted);
  }

  _setSpawnBehavior(fn) {
    this._spawnBehavior = fn;
  }

  _getSpawnHistory() {
    return [...this._spawnHistory];
  }

  spawn(command, args = []) {
    if (!this._processGranted) {
      throw new Error("the listener hasn't allowed this plugin to start programs");
    }

    const record = { command, args: [...args], stdin: "", killed: false };
    this._spawnHistory.push(record);

    let outputLines = ["OK"];
    let stderrText = "";
    let exitCode = 0;
    let resolved = false;

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      if (typeof this._spawnBehavior === "function") {
        const res = this._spawnBehavior(record);
        if (res && typeof res === "object") {
          if (Array.isArray(res.lines)) outputLines = [...res.lines];
          else if (typeof res.stdout === "string") {
            outputLines = res.stdout === "" ? [] : res.stdout.split(/\r?\n/);
          }
          if (typeof res.stderr === "string") stderrText = res.stderr;
          if (typeof res.code === "number") exitCode = res.code;
        } else if (typeof res === "string") {
          outputLines = res === "" ? [] : res.split(/\r?\n/);
        }
      }
    };

    let cursor = 0;
    return {
      pid: 4242,
      write: (text) => {
        record.stdin += String(text ?? "");
      },
      closeStdin: () => {
        finalize();
      },
      readLine: async () => {
        finalize();
        if (cursor >= outputLines.length) return null;
        return outputLines[cursor++];
      },
      errorOutput: () => stderrText,
      wait: async () => {
        finalize();
        return exitCode;
      },
      kill: () => {
        record.killed = true;
      },
    };
  }

  reset() {
    this._storageMap.clear();
    this._settingsMap.clear();
    this._openedURLs = [];
    this._webSignInBehavior = null;
    this._spawnBehavior = null;
    this._spawnHistory = [];
    this._processGranted = true;
    this._currentLanguage = "en";
  }
}

export function createHost(options = {}) {
  return new MockHost(options);
}
