import { redactUrl, stableId } from "./url.js";

const TASK_KEY = "vwd.tasks";
const DRAFT_KEY = "vwd.draft";
const MAX_TASKS = 50;

function storage() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) throw new Error("扩展存储不可用。");
  return chrome.storage.local;
}

function draftStorage() {
  if (typeof chrome === "undefined" || !chrome.storage) throw new Error("扩展存储不可用。");
  return chrome.storage.session || chrome.storage.local;
}

export async function listTasks() {
  const result = await storage().get(TASK_KEY);
  return Array.isArray(result[TASK_KEY]) ? result[TASK_KEY] : [];
}

export async function createTask(config) {
  const task = {
    id: `task-${Date.now().toString(36)}-${stableId(Math.random())}`,
    title: config.title || "网页视频",
    sourceUrl: redactUrl(config.sourceUrl || config.input || ""),
    protocol: config.protocol || "unknown",
    status: "pending",
    progress: 0,
    downloadedBytes: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: ""
  };
  const tasks = await listTasks();
  await storage().set({ [TASK_KEY]: [task, ...tasks].slice(0, MAX_TASKS) });
  return task;
}

export async function updateTask(taskId, patch) {
  const tasks = await listTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  tasks[index] = { ...tasks[index], ...patch, updatedAt: Date.now() };
  await storage().set({ [TASK_KEY]: tasks.slice(0, MAX_TASKS) });
  return tasks[index];
}

export async function clearTasks() {
  await storage().remove(TASK_KEY);
}

export async function saveDraft(draft) {
  await draftStorage().set({ [DRAFT_KEY]: { ...draft, savedAt: Date.now() } });
}

export async function loadDraft() {
  const result = await draftStorage().get(DRAFT_KEY);
  return result[DRAFT_KEY] || null;
}

export async function clearDraft() {
  await draftStorage().remove(DRAFT_KEY);
}
