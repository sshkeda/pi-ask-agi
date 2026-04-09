/**
 * Configuration — model registry.
 *
 * Each model has a name and a URL to its official prompting guide.
 * The agent fetches the guide fresh each time to stay up-to-date.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ModelConfig {
  id: string;
  name: string;
  guideUrl: string; // URL to the official prompting guide
}

export interface Config {
  defaultModel: string;
  models: ModelConfig[];
}

const CONFIG_DIR = path.join(os.homedir(), ".pi-ask-agi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  defaultModel: "gpt-5-4-pro",
  models: [
    {
      id: "gpt-5-4-pro",
      name: "GPT-5-4 Pro",
      guideUrl: "https://developers.openai.com/docs/guides/prompt-guidance.md",
    },
  ],
};

export function loadConfig(): Config {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return {
      defaultModel: raw.defaultModel ?? DEFAULT_CONFIG.defaultModel,
      models: raw.models ?? DEFAULT_CONFIG.models,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getModel(config: Config, id: string): ModelConfig | undefined {
  return config.models.find((m) => m.id === id);
}

export function getDefaultModel(config: Config): ModelConfig {
  return getModel(config, config.defaultModel) ?? config.models[0] ?? DEFAULT_CONFIG.models[0];
}

export function getModelIds(config: Config): string[] {
  return config.models.map((m) => m.id);
}
