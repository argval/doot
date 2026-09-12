# Accuracy and latency checks

No representative recordings have been checked in. Synthetic tests verify routing, interval identity and timing arithmetic; they do **not** establish translation accuracy or a reduction from the reported 3–4 second delay.

Keep consented, non-sensitive clips and reports in `accuracy-local/` (ignored by Git). Use 15–60 seconds per clip, PCM16 mono at 16 kHz. Start with these lanes:

| Lane | Include |
| --- | --- |
| English → English | short pauses, names, numbers, corrected sentences |
| Hindi/English → English | code-switching within a sentence |
| Kannada/English → English | code-switching and longer continuous speech |
| English → Kannada | translation that changes word order |
| Spanish → English | fast commentary, interruptions, background music |
| Japanese → Japanese | boundaries without spaces or Latin punctuation |
| Urdu → Urdu | RTL rendering and rapid draft corrections |

For every clip, a fluent listener supplies `sourceText` and expected `boundariesMs`, including the final boundary. Annotate audible speech intervals, not arbitrary visual line wraps. Independently assess translated meaning: omissions, invented content, names/numbers, code-switching, and whether a sentence stays understandable while revising. WER/CER do not score translated meaning.

Example `accuracy-local/corpus.json` (paths relative to the manifest):

```json
{
  "repeats": 5,
  "cases": [
    { "id": "kannada-code-switch", "audio": "kn-en.pcm", "reference": "kn-en.reference.json", "source": "kn", "target": "en", "provider": "sarvam" }
  ]
}
```

Run the standalone gateway with appropriate keys and `DOOT_GATEWAY_TOKEN` exported in both terminals. The benchmark sends the supplied clips to those providers and may incur charges. Do not use the private token of a running native app.

```bash
bun run --cwd services/gateway benchmark:corpus ../../accuracy-local/corpus.json > accuracy-local/baseline.json
# After a change, with identical audio, annotations, provider models and settings:
bun run --cwd services/gateway benchmark:corpus ../../accuracy-local/corpus.json ../../accuracy-local/baseline.json > accuracy-local/candidate.json
```

The runner repeats cases sequentially, reports mean per-run p95 lag, WER and boundary F1, and includes individual runs. A negative lag/WER delta is better; a positive F1 delta is better. A delta is omitted if audio, references, pair or requested provider differ. Keep model versions in your experiment notes: the runner cannot pin a hosted model's internals. Do not accept a latency win that introduces lost speech, extra boundaries or degraded meaning. Reports contain transcript text; do not upload them automatically.

For the desktop portion, play the same clip and use **Settings → Connection → Caption timing diagnostics → Read timings**. This reports the last 500 visible revisions, split into drafts/finals. The native clock measures lag from the provider's audio interval end; two animation frames after the React commit estimate a paint opportunity. Provider timestamps are not word-aligned and this is not a physical display measurement. Hidden/superseded revisions and invalid clock samples are excluded. Copy diagnostics exports timings and provider names only, kept in memory until quit.

Compare p50 and p95 across at least five runs. Record first-readable-caption delay separately from finalization delay; a final caption often arrives later even when progressive captions are already useful.
