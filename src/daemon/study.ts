import { join } from 'node:path';
import { privateDirectory } from '../shared/paths.js';
import { addonFile } from '../agent/addon-bundle.js';
import { atomicWrite } from './store.js';

// v1.1 /study: a small review schedule in ~/.ai-term/study/schedule.json (AI Term's own private folder). A topic studied
// today is due tomorrow; each review pushes it further out (spaced review). /study alone lists what is due today.
export const STUDY_DAYS = [1, 3, 7, 16, 35], STUDY_TOPICS = 200, STUDY_FILE_MAX = 256 * 1024;
export interface StudyEntry { topic: string; due: string; step: number }
const slug = (topic: string) => topic.trim().toLowerCase().replace(/\s+/g, ' ');
const dateOf = (when: Date) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
const after = (when: Date, days: number) => dateOf(new Date(when.getFullYear(), when.getMonth(), when.getDate() + days, 12));
async function read(root: string): Promise<StudyEntry[]> {
  const folder = join(root, 'study'); await privateDirectory(folder);
  let text: string;
  try { text = await addonFile(folder, 'schedule.json', STUDY_FILE_MAX); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  const data: unknown = JSON.parse(text);
  const valid = (e: unknown): e is StudyEntry => !!e && typeof e === 'object' && typeof (e as StudyEntry).topic === 'string' && (e as StudyEntry).topic.length > 0 && (e as StudyEntry).topic.length <= 200 && !/[\p{C}]/u.test((e as StudyEntry).topic)
    && typeof (e as StudyEntry).due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((e as StudyEntry).due) && Number.isSafeInteger((e as StudyEntry).step) && (e as StudyEntry).step >= 0 && (e as StudyEntry).step < STUDY_DAYS.length;
  if (!Array.isArray(data) || data.length > STUDY_TOPICS || !data.every(valid)) throw new Error('The study schedule is unreadable; remove ~/.ai-term/study/schedule.json to start over');
  return data;
}
// Studied today: a new topic is due tomorrow; a known one moves one interval further (the last interval repeats).
export async function recordStudy(root: string, topic: string, now = new Date()): Promise<void> {
  const entries = await read(root), key = slug(topic), found = entries.find(e => slug(e.topic) === key);
  const step = found ? Math.min(found.step + 1, STUDY_DAYS.length - 1) : 0, entry = { topic: found?.topic ?? topic.trim().slice(0, 200), due: after(now, STUDY_DAYS[found ? step : 0] ?? 1), step };
  const next = [...entries.filter(e => slug(e.topic) !== key), entry].slice(-STUDY_TOPICS);
  await atomicWrite(join(root, 'study', 'schedule.json'), next);
}
export async function dueStudies(root: string, now = new Date()): Promise<StudyEntry[]> {
  const today = dateOf(now);
  return (await read(root)).filter(e => e.due <= today).sort((a, b) => a.due.localeCompare(b.due) || a.topic.localeCompare(b.topic));
}
