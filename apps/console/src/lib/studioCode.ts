// SPDX-License-Identifier: Apache-2.0
import type { StudioCode } from "./workspaces";
export const STARTER_CODE: StudioCode = {
  html: '<section class="card"><small>STUDIO COMPONENT</small><h2>Make it yours</h2><p>Combine code with your page data and actions.</p><button data-event="increment">Clicked 0 times</button></section>',
  css: ".card{padding:24px;border-radius:20px;background:linear-gradient(135deg,#eef2ff,#f0fdfa)}small{letter-spacing:.14em;color:#6366f1}h2{font-size:28px;margin:12px 0}p{color:#64748b}button{border:0;border-radius:10px;padding:12px 18px;background:#4f46e5;color:white}",
  javascript:
    '// HTML uses data-event to connect controls to JavaScript.\n// JavaScript runs in a worker; use studio.render() to update the UI.\nlet count = 0;\nstudio.on("increment", () => {\n  count += 1;\n  studio.render(`<section class="card"><small>STUDIO COMPONENT</small><h2>Make it yours</h2><p>State lives in this component.</p><button data-event="increment">Clicked ${count} times</button></section>`);\n  console.log("Click count", count);\n});\nconsole.info("Component ready");',
  inputs: [],
  actions: [],
  height: 300,
};
