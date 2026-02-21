import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TLVC_ROOT = "/Users/Shared/tlvc";
const PAGE_SIZE = 8;

const TLVC_MENU_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "t", description: "TLVC (menu)" },
  { command: "tlvs", description: "TLVC menu" },
  { command: "tlvc_status", description: "Episode status" },
  { command: "tlvc_deliver", description: "Deliver zip/dir" },
  { command: "tlvc", description: "TLVC" },
];

let tlvcCommandsRegistered = false;
async function ensureTlvcCommands(bot: {
  api: {
    getMyCommands?: () => Promise<Array<{ command: string; description: string }>>;
    setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<unknown>;
  };
}): Promise<void> {
  if (tlvcCommandsRegistered) {
    return;
  }
  try {
    const current: Array<{ command: string; description: string }> =
      (typeof bot.api.getMyCommands === "function" ? await bot.api.getMyCommands() : []) ?? [];
    const existingSet = new Set(current.map((c) => c.command.toLowerCase()));
    const toAdd = TLVC_MENU_COMMANDS.filter((c) => !existingSet.has(c.command.toLowerCase()));
    if (toAdd.length === 0) {
      tlvcCommandsRegistered = true;
      return;
    }
    const merged = [...current, ...toAdd].slice(0, 100);
    await bot.api.setMyCommands(merged);
    tlvcCommandsRegistered = true;
  } catch {
    // non-fatal
  }
}

/** Pending deliver: wait for user to reply with EP or "-". Key = chatId or chatId_threadId. */
const pendingDeliver = new Map<string, { path: string; kind: string }>();
const PENDING_TTL_MS = 15 * 60 * 1000;
function setPendingDeliver(
  chatId: number,
  threadId: number | undefined,
  payload: { path: string; kind: string },
): void {
  const key = threadId != null ? `${chatId}_${threadId}` : String(chatId);
  pendingDeliver.set(key, payload);
  setTimeout(() => pendingDeliver.delete(key), PENDING_TTL_MS);
}
function getAndClearPendingDeliver(
  chatId: number,
  threadId: number | undefined,
): { path: string; kind: string } | null {
  const key = threadId != null ? `${chatId}_${threadId}` : String(chatId);
  const p = pendingDeliver.get(key) ?? null;
  if (p) {
    pendingDeliver.delete(key);
  }
  return p;
}

/** Store deliver candidates for callback by index. Key = chatId_messageId. */
const deliverCandidatesStore = new Map<string, { path: string; kind: string }[]>();
const CANDIDATES_TTL_MS = 15 * 60 * 1000;
function storeDeliverCandidates(
  chatId: number,
  messageId: number,
  candidates: { path: string; kind: string }[],
): void {
  const key = `${chatId}_${messageId}`;
  deliverCandidatesStore.set(key, candidates);
  setTimeout(() => deliverCandidatesStore.delete(key), CANDIDATES_TTL_MS);
}

type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token">;
};

// Legacy path must not appear in deliver stdout/inboxDir (reject with FATAL)
const TLVC_LEGACY_PATTERN = "yzliu/work/tlvc";
const TLVC_API_BASE = "http://127.0.0.1:8789";

function getTlvcEnv(): {
  homedir: string;
  tlvcDir: string;
  env: Record<string, string | undefined>;
} {
  const homedir = process.env.HOME ?? os.homedir();
  const tlvcDir = path.join(homedir, ".openclaw", "workspace", "tools", "tlvc");
  const env = {
    ...process.env,
    TLVC_ROOT: DEFAULT_TLVC_ROOT,
    TLVC_TOKEN_FILE: path.join(DEFAULT_TLVC_ROOT, ".secrets", "tlvc.token"),
    TLVC_API_BASE,
    TLVC_IMPORT_ROOT: path.join(DEFAULT_TLVC_ROOT, "uploads", "file"),
  };
  return { homedir, tlvcDir, env };
}

/** Path must be under TLVC_ROOT/uploads/zip or uploads/file. */
function isAllowedUploadPath(candidatePath: string): boolean {
  const root = path.normalize(DEFAULT_TLVC_ROOT);
  const p = path.normalize(candidatePath);
  const zipDir = path.join(root, "uploads", "zip");
  const fileDir = path.join(root, "uploads", "file");
  return (
    p === zipDir ||
    p.startsWith(zipDir + path.sep) ||
    p === fileDir ||
    p.startsWith(fileDir + path.sep)
  );
}

/** Normalize EP: "0010" -> "ep_0010", "ep_0010" -> "ep_0010". */
function normalizeEp(input: string): string {
  const s = input.trim();
  if (/^ep_[0-9]{4}$/.test(s)) {
    return s;
  }
  if (/^[0-9]{4}$/.test(s)) {
    return "ep_" + s;
  }
  return "";
}

async function tryTlvcHardRoute(
  bot: TelegramMessageProcessorDeps["bot"],
  primaryCtx: TelegramContext,
): Promise<boolean> {
  const text = (primaryCtx.message?.text ?? primaryCtx.message?.caption ?? "").trim();
  const chatId = primaryCtx.message?.chat?.id;
  const threadId = primaryCtx.message?.message_thread_id;
  if (chatId == null || typeof chatId !== "number") {
    return false;
  }
  const { homedir: _homedir, tlvcDir, env } = getTlvcEnv();
  const opts = threadId ? { message_thread_id: threadId } : {};

  await ensureTlvcCommands(bot);

  // Pending deliver: next message is EP input ("-" or empty = auto, "0010" or "ep_0010" = use it)
  const pending = getAndClearPendingDeliver(chatId, threadId);
  if (pending) {
    if (!isAllowedUploadPath(pending.path)) {
      await bot.api.sendMessage(chatId, "Invalid path (forbidden).", opts);
      return true;
    }
    let epArg: string;
    const t = text.trim();
    if (t === "" || t === "-" || t.toLowerCase() === "auto") {
      const nextEpPath = path.resolve(tlvcDir, "tlvc_next_ep");
      try {
        const { stdout } = await execFileAsync(nextEpPath, [], { env, maxBuffer: 1024 });
        const raw = (stdout || "").trim().split("\n")[0]?.trim() ?? "";
        if (!/^ep_\d{4,}$/.test(raw)) {
          await bot.api.sendMessage(
            chatId,
            `FAILED: tlvc_next_ep returned invalid: ${raw.slice(0, 80) || "(empty)"}`,
            opts,
          );
          return true;
        }
        epArg = raw;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api.sendMessage(chatId, `FAILED: tlvc_next_ep error: ${msg.slice(0, 500)}`, opts);
        return true;
      }
    } else {
      const normalized = normalizeEp(t);
      if (!normalized) {
        await bot.api.sendMessage(chatId, "FAILED: invalid EP (use 0010 or ep_0010).", opts);
        return true;
      }
      epArg = normalized;
    }
    const outDir = path.join(DEFAULT_TLVC_ROOT, "artifacts", epArg);
    let scriptStdout = "";
    let stderr = "";
    let code = 0;
    try {
      const r = await execFileAsync(
        path.resolve(tlvcDir, "tlvc_deliver"),
        ["--ep", epArg, "--zip", pending.path, "--out", outDir],
        { env, maxBuffer: 64 * 1024 },
      );
      scriptStdout = r.stdout ?? "";
    } catch (e: unknown) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      code = x.code ?? 1;
      scriptStdout = x.stdout ?? "";
      stderr = x.stderr ?? "";
    }
    if (code !== 0) {
      const stderrLines = (stderr || "").trim().split("\n").slice(-40).join("\n");
      const out = (scriptStdout || "").trim() + `\nFAILED (exit=${code}): ${stderrLines}`;
      await bot.api.sendMessage(chatId, out.slice(0, 4096), opts);
      return true;
    }
    if ((scriptStdout || "").includes(TLVC_LEGACY_PATTERN)) {
      await bot.api.sendMessage(
        chatId,
        "FATAL legacy path in deliver output; refusing. Check TLVC_ROOT.",
        opts,
      );
      return true;
    }
    const outDirMatch = (scriptStdout || "").match(/outDir:\s*(\S+)/);
    const outDirPath = outDirMatch ? outDirMatch[1].trim() : "";
    if (outDirPath && !fs.existsSync(outDirPath)) {
      const out =
        (scriptStdout || "").trim() +
        `\nFAILED (contract broken): outDir does not exist: ${outDirPath}` +
        (stderr ? `\n${(stderr || "").trim().split("\n").slice(-20).join("\n")}` : "");
      await bot.api.sendMessage(chatId, out.slice(0, 4096), opts);
      return true;
    }
    await bot.api.sendMessage(chatId, (scriptStdout || "").trim().slice(0, 4096), opts);
    return true;
  }

  if (text === "/t" || text === "/tlvs" || text === "/tlvc") {
    await bot.api.sendMessage(chatId, "TLVC", {
      ...opts,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Status", callback_data: "TLVC_MENU:status" },
            { text: "Deliver", callback_data: "TLVC_MENU:deliver" },
          ],
        ],
      },
    });
    return true;
  }

  if (text.startsWith("/tlvc_status")) {
    const rest = text.slice("/tlvc_status".length).trim().split(/\s+/)[0];
    const epId = rest ? normalizeEp(rest) : "";
    if (epId) {
      try {
        const { stdout, stderr } = await execFileAsync(
          path.join(tlvcDir, "tlvc_status"),
          ["--ep", epId],
          { env, maxBuffer: 64 * 1024 },
        );
        await bot.api.sendMessage(chatId, (stdout || stderr || "OK").trim(), opts);
        return true;
      } catch (err: unknown) {
        await bot.api.sendMessage(
          chatId,
          `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
          opts,
        );
        return true;
      }
    }
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["status", "--limit", String(PAGE_SIZE), "--offset", "0"],
        { env, maxBuffer: 16 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as { eps?: string[]; display?: string[] };
      const eps = j.eps ?? [];
      const display = j.display ?? eps.map((e) => e.replace(/^ep_/, ""));
      if (eps.length === 0) {
        await bot.api.sendMessage(chatId, "No episodes.", opts);
        return true;
      }
      const total = (j as { total?: number }).total ?? eps.length;
      const rows = display.map((d, i) => ({ text: d, callback_data: `TLVC_STATUS:${eps[i]}` }));
      const nav: { text: string; callback_data: string }[] = [];
      if (total > PAGE_SIZE) {
        nav.push({ text: "Next", callback_data: "TLVC_STATUS_PAGE:8" });
      }
      await bot.api.sendMessage(chatId, "Select episode:", {
        ...opts,
        reply_markup: { inline_keyboard: [rows, nav].filter((r) => r.length > 0) },
      });
      return true;
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
      return true;
    }
  }

  if (text.startsWith("/tlvc_deliver")) {
    const parts = text.slice("/tlvc_deliver".length).trim().split(/\s+/).filter(Boolean);
    let epArg = "";
    let zipPath = "";
    if (parts.length >= 2) {
      epArg = parts[0];
      zipPath = parts[1];
      if (epArg === "-") {
        epArg = "";
      }
    } else if (parts.length === 1) {
      zipPath = parts[0];
    }
    if (zipPath) {
      if (!isAllowedUploadPath(path.resolve(zipPath))) {
        await bot.api.sendMessage(
          chatId,
          "Path must be under TLVC uploads/zip or uploads/file.",
          opts,
        );
        return true;
      }
      const args = ["--zip", zipPath];
      if (epArg) {
        const ep = normalizeEp(epArg) || "ep_0001";
        args.unshift("--ep", ep);
        args.push("--out", path.join(DEFAULT_TLVC_ROOT, "artifacts", ep));
      }
      let stdout = "";
      let stderr = "";
      let code = 0;
      try {
        const r = await execFileAsync(path.join(tlvcDir, "tlvc_deliver"), args, {
          env,
          maxBuffer: 64 * 1024,
        });
        stdout = r.stdout ?? "";
      } catch (e: unknown) {
        const x = e as { code?: number; stdout?: string; stderr?: string };
        code = x.code ?? 1;
        stdout = x.stdout ?? "";
        stderr = x.stderr ?? "";
      }
      if (code !== 0) {
        const stderrLines = (stderr || "").trim().split("\n").slice(-40).join("\n");
        const out = (stdout || "").trim() + `\nFAILED (exit=${code}): ${stderrLines}`;
        await bot.api.sendMessage(chatId, out.slice(0, 4096), opts);
      } else {
        if ((stdout || "").includes(TLVC_LEGACY_PATTERN)) {
          await bot.api.sendMessage(chatId, "FATAL legacy path in deliver output; refusing.", opts);
        } else {
          const outDirM = (stdout || "").match(/outDir:\s*(\S+)/);
          const outDirP = outDirM ? outDirM[1].trim() : "";
          if (outDirP && !fs.existsSync(outDirP)) {
            const msg =
              (stdout || "").trim() +
              "\nFAILED (contract broken): outDir does not exist: " +
              outDirP +
              (stderr ? "\n" + (stderr || "").trim().split("\n").slice(-20).join("\n") : "");
            await bot.api.sendMessage(chatId, msg.slice(0, 4096), opts);
          } else {
            await bot.api.sendMessage(chatId, (stdout || "").trim().slice(0, 4096), opts);
          }
        }
      }
      return true;
    }
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["deliver", "--limit", String(PAGE_SIZE), "--offset", "0"],
        { env, maxBuffer: 64 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as {
        candidates?: { kind: string; display: string; path: string }[];
        total?: number;
      };
      const candidates = j.candidates ?? [];
      const total = j.total ?? candidates.length;
      if (candidates.length === 0) {
        await bot.api.sendMessage(chatId, "No uploads (zip/file) to deliver.", opts);
        return true;
      }
      const rows = candidates.map((c, i) => ({
        text: c.display,
        callback_data: `TLVC_DELIVER_CAND:${i}`,
      }));
      const nav: { text: string; callback_data: string }[] = [];
      if (total > PAGE_SIZE) {
        nav.push({ text: "Next", callback_data: "TLVC_DELIVER_PAGE:8" });
      }
      const sent = await bot.api.sendMessage(chatId, "Select candidate:", {
        ...opts,
        reply_markup: {
          inline_keyboard: [...rows.map((r) => [r]), nav].filter((r) => r.length > 0),
        },
      });
      const sid = (sent as { message_id?: number }).message_id;
      if (typeof sid === "number") {
        storeDeliverCandidates(
          chatId,
          sid,
          candidates.map((c) => ({ path: c.path, kind: c.kind })),
        );
      }
      return true;
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
      return true;
    }
  }

  return false;
}

export async function handleTlvcCallbackQuery(
  bot: TelegramMessageProcessorDeps["bot"],
  callbackQuery: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number; message_thread_id?: number };
  },
): Promise<boolean> {
  const data = callbackQuery.data;
  if (typeof data !== "string" || !data.startsWith("TLVC_")) {
    return false;
  }
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const threadId = callbackQuery.message?.message_thread_id;
  if (chatId == null || messageId == null) {
    return false;
  }
  const { tlvcDir, env } = getTlvcEnv();
  const opts = threadId ? { message_thread_id: threadId } : {};

  try {
    await bot.api.answerCallbackQuery(callbackQuery.id);
  } catch {
    // ignore
  }

  if (data === "TLVC_MENU:status") {
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["status", "--limit", String(PAGE_SIZE), "--offset", "0"],
        { env, maxBuffer: 16 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as {
        eps?: string[];
        display?: string[];
        total?: number;
      };
      const eps = j.eps ?? [];
      const display = j.display ?? eps.map((e) => e.replace(/^ep_/, ""));
      if (eps.length === 0) {
        await bot.api.sendMessage(chatId, "No episodes.", opts);
        return true;
      }
      const total = j.total ?? eps.length;
      const rows = display.map((d, i) => ({ text: d, callback_data: `TLVC_STATUS:${eps[i]}` }));
      const nav: { text: string; callback_data: string }[] = [];
      if (total > PAGE_SIZE) {
        nav.push({ text: "Next", callback_data: "TLVC_STATUS_PAGE:8" });
      }
      await bot.api.sendMessage(chatId, "Select episode:", {
        ...opts,
        reply_markup: { inline_keyboard: [rows, nav].filter((r) => r.length > 0) },
      });
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
    }
    return true;
  }

  if (data.startsWith("TLVC_STATUS_PAGE:")) {
    const offset = parseInt(data.slice("TLVC_STATUS_PAGE:".length), 10) || 0;
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["status", "--limit", String(PAGE_SIZE), "--offset", String(offset)],
        { env, maxBuffer: 16 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as {
        eps?: string[];
        display?: string[];
        total?: number;
      };
      const eps = j.eps ?? [];
      const display = j.display ?? eps.map((e) => e.replace(/^ep_/, ""));
      const total = j.total ?? 0;
      const rows = display.map((d, i) => ({ text: d, callback_data: `TLVC_STATUS:${eps[i]}` }));
      const nav: { text: string; callback_data: string }[] = [];
      if (offset > 0) {
        nav.push({
          text: "Prev",
          callback_data: `TLVC_STATUS_PAGE:${Math.max(0, offset - PAGE_SIZE)}`,
        });
      }
      if (offset + PAGE_SIZE < total) {
        nav.push({ text: "Next", callback_data: `TLVC_STATUS_PAGE:${offset + PAGE_SIZE}` });
      }
      await bot.api.sendMessage(chatId, "Select episode:", {
        ...opts,
        reply_markup: { inline_keyboard: [rows, nav].filter((r) => r.length > 0) },
      });
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
    }
    return true;
  }

  if (data === "TLVC_MENU:deliver") {
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["deliver", "--limit", String(PAGE_SIZE), "--offset", "0"],
        { env, maxBuffer: 64 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as {
        candidates?: { kind: string; display: string; path: string }[];
        total?: number;
      };
      const candidates = j.candidates ?? [];
      const total = j.total ?? candidates.length;
      if (candidates.length === 0) {
        await bot.api.sendMessage(chatId, "No uploads (zip/file) to deliver.", opts);
        return true;
      }
      const rows = candidates.map((c, i) => ({
        text: c.display,
        callback_data: `TLVC_DELIVER_CAND:${i}`,
      }));
      const nav: { text: string; callback_data: string }[] = [];
      if (total > PAGE_SIZE) {
        nav.push({ text: "Next", callback_data: "TLVC_DELIVER_PAGE:8" });
      }
      const sent = await bot.api.sendMessage(chatId, "Select candidate:", {
        ...opts,
        reply_markup: {
          inline_keyboard: [...rows.map((r) => [r]), nav].filter((r) => r.length > 0),
        },
      });
      const sid = (sent as { message_id?: number }).message_id;
      if (typeof sid === "number") {
        storeDeliverCandidates(
          chatId,
          sid,
          candidates.map((c) => ({ path: c.path, kind: c.kind })),
        );
      }
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
    }
    return true;
  }

  if (data.startsWith("TLVC_DELIVER_PAGE:")) {
    const offset = parseInt(data.slice("TLVC_DELIVER_PAGE:".length), 10) || 0;
    try {
      const { stdout } = await execFileAsync(
        path.join(tlvcDir, "tlvc_ls_eps"),
        ["deliver", "--limit", String(PAGE_SIZE), "--offset", String(offset)],
        { env, maxBuffer: 64 * 1024 },
      );
      const j = JSON.parse(stdout || "{}") as {
        candidates?: { kind: string; display: string; path: string }[];
        total?: number;
      };
      const candidates = j.candidates ?? [];
      const total = j.total ?? candidates.length;
      if (candidates.length === 0) {
        await bot.api.sendMessage(chatId, "No more candidates.", opts);
        return true;
      }
      const rows = candidates.map((c, i) => ({
        text: c.display,
        callback_data: `TLVC_DELIVER_CAND:${i}`,
      }));
      const nav: { text: string; callback_data: string }[] = [];
      if (offset > 0) {
        nav.push({
          text: "Prev",
          callback_data: `TLVC_DELIVER_PAGE:${Math.max(0, offset - PAGE_SIZE)}`,
        });
      }
      if (offset + PAGE_SIZE < total) {
        nav.push({ text: "Next", callback_data: `TLVC_DELIVER_PAGE:${offset + PAGE_SIZE}` });
      }
      const sent = await bot.api.sendMessage(chatId, "Select candidate:", {
        ...opts,
        reply_markup: {
          inline_keyboard: [...rows.map((r) => [r]), nav].filter((r) => r.length > 0),
        },
      });
      const sid = (sent as { message_id?: number }).message_id;
      if (typeof sid === "number") {
        storeDeliverCandidates(
          chatId,
          sid,
          candidates.map((c) => ({ path: c.path, kind: c.kind })),
        );
      }
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
    }
    return true;
  }

  if (data.startsWith("TLVC_STATUS:")) {
    const ep = data.slice("TLVC_STATUS:".length).trim();
    if (!/^ep_[0-9]{4}$/.test(ep)) {
      return true;
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        path.join(tlvcDir, "tlvc_status"),
        ["--ep", ep],
        { env, maxBuffer: 64 * 1024 },
      );
      await bot.api.sendMessage(chatId, (stdout || stderr || "OK").trim(), opts);
    } catch (err: unknown) {
      await bot.api.sendMessage(
        chatId,
        `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 4000)}`,
        opts,
      );
    }
    return true;
  }

  if (data.startsWith("TLVC_DELIVER_CAND:")) {
    const idx = parseInt(data.slice("TLVC_DELIVER_CAND:".length), 10);
    if (!Number.isFinite(idx)) {
      return true;
    }
    const candidates = deliverCandidatesStore.get(`${chatId}_${messageId}`);
    const candidate = candidates && candidates[idx];
    if (!candidate) {
      await bot.api.sendMessage(chatId, "Selection expired or invalid.", opts);
      return true;
    }
    if (!isAllowedUploadPath(candidate.path)) {
      await bot.api.sendMessage(chatId, "Invalid path (forbidden).", opts);
      return true;
    }
    setPendingDeliver(chatId, threadId, candidate);
    await bot.api.sendMessage(
      chatId,
      'Reply with EP (optional): send "0010" or "ep_0010". Send "-" for auto.',
      opts,
    );
    return true;
  }

  return false;
}

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  } = deps;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
  ) => {
    if (await tryTlvcHardRoute(bot, primaryCtx)) {
      return;
    }
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    if (!context) {
      return;
    }
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
    });
  };
};
