// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";

export function CodeEditor({
  value,
  language,
  onChange,
  label,
  readOnly = false,
}: {
  value: string;
  language: "javascript" | "html" | "css" | "json";
  onChange: (value: string) => void;
  label: string;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null),
    callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      doc: value,
      parent: host.current,
      extensions: [
        basicSetup,
        EditorView.editable.of(!readOnly),
        { javascript, html, css, json }[language](),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callback.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, monospace",
          },
          ".cm-content": { minHeight: "360px" },
          ".cm-gutters": {
            background: "#f2f5fa",
            color: "#7a869b",
            border: "none",
          },
          ".cm-activeLine": { background: "#eef2ff" },
        }),
      ],
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [language, label, readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  return (
    <div
      ref={host}
      className="h-[420px] overflow-hidden rounded-xl border border-dx-line bg-white text-slate-900"
    />
  );
}
