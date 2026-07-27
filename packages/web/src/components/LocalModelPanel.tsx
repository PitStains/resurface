import { useEffect, useState } from "react";
import { api, postJson, request } from "../api.ts";

export interface LlmProbe {
  ok: boolean;
  reachable: boolean;
  models: string[];
  problem: string;
  fix: string;
  url: string;
}
interface LlmSettings {
  llm: { provider: "ollama"; url?: string; model?: string } | null;
  probe: LlmProbe | null;
}

/**
 * Connecting a local model, honestly.
 *
 * The old flow was a browser prompt() and an unconditional save: a machine with
 * no Ollama on it still ended up "connected", every question then failed with a
 * raw "fetch failed", and the connect button had disappeared because it only
 * rendered while disconnected — leaving no way back. So this panel is always
 * visible, never saves a setting that hasn't answered a live probe, says what
 * is wrong in words, and can always disconnect.
 */
export default function LocalModelPanel() {
  const [state, setState] = useState<LlmSettings | null>(null);
  const [model, setModel] = useState("llama3.2");
  const [probe, setProbe] = useState<LlmProbe | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api<LlmSettings>("/api/settings/llm")
      .then((s) => {
        setState(s);
        if (s.llm?.model) setModel(s.llm.model);
        setProbe(s.probe);
      })
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  async function test() {
    setBusy(true);
    try {
      setProbe(await postJson<LlmProbe>("/api/settings/llm/probe", { model }));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const res = await request("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: { provider: "ollama", model } }),
      });
      const body = (await res.json()) as { ok: boolean; probe: LlmProbe | null };
      setProbe(body.probe);
      if (body.ok) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await postJson("/api/settings/llm", { llm: null });
      setProbe(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const connected = !!state?.llm;
  const healthy = connected && state?.probe?.ok !== false;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Local model{" "}
          <span className="ink-2 font-normal">
            {connected ? (healthy ? "· connected" : "· connected, but not responding") : "· not connected"}
          </span>
        </h2>
        {connected && (
          <button className="link text-xs" onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        )}
      </div>

      <p className="muted mt-2 text-xs">
        Optional. Without one, Ask quotes your snips word for word — which is why it can't invent anything. With{" "}
        <span className="font-medium">Ollama</span> running locally, you also get a short written summary over those
        same cited passages. It stays on your machine and costs nothing.
      </p>

      {!healthy && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llama3.2"
            aria-label="Ollama model name"
            className="card px-2 py-1 text-sm"
          />
          <button className="btn text-xs" onClick={test} disabled={busy}>
            {busy ? "Checking…" : "Test connection"}
          </button>
          <button className="btn text-xs" onClick={connect} disabled={busy}>
            Connect
          </button>
        </div>
      )}

      {probe && !probe.ok && (
        <div className="mt-3 text-xs">
          <p className="font-medium">{probe.problem}</p>
          <p className="muted mt-1 whitespace-pre-wrap">{probe.fix}</p>
          {!probe.reachable && (
            <p className="muted mt-2">
              Resurface can't install Ollama for you — it's a separate program, and nothing here will download
              software onto your machine without you asking.
            </p>
          )}
        </div>
      )}
      {probe?.ok && (
        <p className="mt-3 text-xs">
          Reachable at {probe.url} — models: {probe.models.join(", ")}
        </p>
      )}
    </div>
  );
}
