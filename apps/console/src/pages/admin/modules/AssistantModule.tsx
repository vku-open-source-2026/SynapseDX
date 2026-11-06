// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Assistant lane: grounded Q&A with numbered citations and usage metering. */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Loader2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { Button, Chip, inputClassName } from '../../../components/ui';

interface RagUsage {
  queries?: number;
  costUsd?: number;
  noAnswer?: number;
}
interface RagAnswer {
  answer?: string;
  noAnswer?: boolean;
  confidence?: number;
  citations?: Array<{ index: number; title: string }>;
  generator?: 'llm' | 'extractive';
  retrieval?: string;
  model?: string;
}

function retrievalLabel(retrieval?: string): string {
  if (!retrieval) return '';
  return retrieval.startsWith('tier1/') ? `semantic · ${retrieval.slice(6)}` : 'keyword + hash';
}

export function AssistantModule() {
  const usage = useQuery({
    queryKey: ['rag-usage'],
    queryFn: () => api.get<RagUsage>('/v1/capabilities/rag/usage').catch(() => ({ queries: 0, costUsd: 0, noAnswer: 0 })),
    retry: false,
  });
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await api.post<RagAnswer>('/v1/capabilities/rag/query', { question: q });
      setAnswer(result);
    } catch (failure) {
      setError((failure as Error)?.message || 'The assistant is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const stats = usage.data ?? { queries: 0, costUsd: 0, noAnswer: 0 };

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Grounded assistant</h2>
        <p className="text-sm text-slate-500">Answers cite only sources the caller can open; prompt-injection patterns are refused.</p>
      </div>

      <form onSubmit={ask} className="flex flex-wrap items-center gap-2" id="rag-form">
        <input
          id="rag-question"
          className={`${inputClassName} min-w-0 flex-1`}
          placeholder="Ask a question about accessible workspace, datasets or files…"
          aria-label="Question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button variant="primary" type="submit" disabled={busy || !question.trim()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Ask
        </Button>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-live="polite">
        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">{error}</p>
        ) : busy ? (
          <p className="text-sm text-slate-500">Retrieving accessible sources…</p>
        ) : answer ? (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Answer</p>
            <h3 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {answer.noAnswer ? 'No grounded answer' : `Confidence ${Math.round((answer.confidence || 0) * 100)}%`}
            </h3>
            <p className="mt-2 leading-7 text-slate-700">{answer.answer}</p>
            {!answer.noAnswer && answer.generator ? (
              <p className="mt-2 text-xs text-slate-500" data-testid="rag-provenance">
                {answer.generator === 'llm' ? `Written by ${answer.model || 'the Tier-1 LLM'} from the cited sources` : 'Quoted from the cited sources'}
                {answer.retrieval ? ` · retrieval: ${retrievalLabel(answer.retrieval)}` : ''}
              </p>
            ) : null}
            {answer.citations?.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {answer.citations.map((citation) => (
                  <Chip key={citation.index}>[{citation.index}] {citation.title}</Chip>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-500">Answers will appear here with numbered citations.</p>
        )}
      </div>

      <p className="text-xs text-slate-500">
        {stats.queries || 0} queries · ${Number(stats.costUsd || 0).toFixed(6)} metered · {stats.noAnswer || 0} no-answer paths
      </p>
    </section>
  );
}
