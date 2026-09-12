import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isProviderId, isSupportedLanguage, isSupportedTargetLanguage } from "@doot/protocol";
import { isRecord } from "../src/util.js";
import { runBenchmark, type BenchmarkOptions, type BenchmarkResult } from "./benchmark-live.js";
import { parseReference } from "./benchmark-metrics.js";

interface CorpusCase extends Pick<BenchmarkOptions, "source" | "target" | "provider"> { id: string; audio: string; reference: string }
interface Scores { lagP95Ms: number | null; wordErrorRate: number | null; boundaryF1: number | null }

export function parseCorpus(value: unknown): { repeats: number; cases: CorpusCase[] } {
  if (!isRecord(value) || !Number.isInteger(value.repeats) || Number(value.repeats) < 1 || Number(value.repeats) > 10
    || !Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 30) throw new Error("Corpus needs 1–30 cases and 1–10 repeats.");
  const ids = new Set<string>();
  const cases = value.cases.map((entry: unknown): CorpusCase => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[\w-]{1,80}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.audio !== "string" || !entry.audio || typeof entry.reference !== "string" || !entry.reference
      || !isSupportedLanguage(entry.source) || !isSupportedTargetLanguage(entry.target) || !isProviderId(entry.provider)) throw new Error("Each corpus case needs a unique id, audio/reference paths, source, target, and provider.");
    ids.add(entry.id);
    return { id: entry.id, audio: entry.audio, reference: entry.reference, source: entry.source, target: entry.target, provider: entry.provider };
  });
  return { repeats: Number(value.repeats), cases };
}

export function compareRuns(current: Scores, baseline: Scores): Scores {
  const delta = (key: keyof Scores) => current[key] === null || baseline[key] === null ? null : Number((current[key]! - baseline[key]!).toFixed(6));
  return { lagP95Ms: delta("lagP95Ms"), wordErrorRate: delta("wordErrorRate"), boundaryF1: delta("boundaryF1") };
}

function scores(runs: BenchmarkResult[]): Scores {
  const mean = (values: Array<number | null | undefined>) => {
    const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  return { lagP95Ms: mean(runs.map((run) => run.estimatedFinalLagMs.p95)), wordErrorRate: mean(runs.map((run) => run.referenceScores?.sourceWordErrorRate)), boundaryF1: mean(runs.map((run) => run.referenceScores?.estimatedBoundaryScore.f1)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, baselinePath] = process.argv.slice(2);
  if (!path) throw new Error("Usage: benchmark:corpus manifest.json [baseline.json]. This sends each clip to its configured provider.");
  const corpus = parseCorpus(JSON.parse(await readFile(path, "utf8")));
  const baseline: unknown = baselinePath ? JSON.parse(await readFile(baselinePath, "utf8")) : null;
  const previous = isRecord(baseline) && Array.isArray(baseline.cases) ? baseline.cases : [];
  const cases = [];
  for (const entry of corpus.cases) {
    const audio = await readFile(resolve(dirname(path), entry.audio));
    const reference = parseReference(JSON.parse(await readFile(resolve(dirname(path), entry.reference), "utf8")));
    if (!audio.length || audio.length % 2 || audio.length > 60 * 32_000 || reference.boundariesMs.some((end) => end > audio.length / 32)) throw new Error(`${entry.id}: use complete PCM16 samples, at most 60 seconds, with boundaries inside the clip.`);
    // Compare only identical audio, reference, language pair, and requested provider.
    const fingerprint = createHash("sha256").update(audio).update(JSON.stringify([reference, entry.source, entry.target, entry.provider])).digest("hex");
    const runs: BenchmarkResult[] = [];
    for (let run = 0; run < corpus.repeats; run++) {
      process.stderr.write(`${entry.id}: run ${run + 1}/${corpus.repeats}\n`);
      runs.push(await runBenchmark({ ...entry, audioPath: entry.audio, gatewayUrl: process.env.DOOT_BENCHMARK_GATEWAY ?? "ws://127.0.0.1:8787/v1/realtime", ...(process.env.DOOT_GATEWAY_TOKEN ? { authToken: process.env.DOOT_GATEWAY_TOKEN } : {}) }, audio, reference));
    }
    const summary = scores(runs);
    const prior = previous.find((item: unknown) => isRecord(item) && item.id === entry.id && item.fingerprint === fingerprint);
    const candidate = isRecord(prior) ? prior.summary : null;
    const priorScores = isRecord(candidate) && ["lagP95Ms", "wordErrorRate", "boundaryF1"].every((key) => candidate[key] === null || (typeof candidate[key] === "number" && Number.isFinite(candidate[key]))) ? candidate as unknown as Scores : null;
    cases.push({ id: entry.id, fingerprint, summary, deltaFromBaseline: priorScores ? compareRuns(summary, priorScores) : null, runs });
    if (runs.some((run) => !run.finalTranslation || run.providerErrors.length || run.unfinishedTurns)) process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), aggregation: "mean of per-run metrics", cases }, null, 2)}\n`);
}
