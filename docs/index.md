---
title: Thinkless
---

<style>
:root {
  color-scheme: light;
  --tl-ink: #111827;
  --tl-muted: #5f6472;
  --tl-panel: rgba(255, 255, 255, 0.88);
  --tl-border: rgba(17, 24, 39, 0.12);
  --tl-blue: #1f6feb;
  --tl-teal: #0f8f86;
  --tl-lime: #84cc16;
  --tl-amber: #c47f00;
  --tl-shadow: 0 24px 70px rgba(17, 24, 39, 0.14);
  --tl-code: #0b1020;
  --tl-command: #f8fafc;
}

body {
  margin: 0;
  background:
    radial-gradient(circle at 20% 0%, rgba(132, 204, 22, 0.16), transparent 32%),
    radial-gradient(circle at 78% 8%, rgba(31, 111, 235, 0.12), transparent 30%),
    linear-gradient(180deg, #f8fafc 0%, #eef4f2 48%, #f7f7fb 100%);
  color: var(--tl-ink);
}

.page-header,
.site-header {
  display: none;
}

.main-content {
  max-width: none;
  padding: 0;
}

.thinkless-install {
  min-height: 100vh;
  display: grid;
  justify-items: center;
  padding: 64px 22px 86px;
  box-sizing: border-box;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.install-shell {
  width: min(1060px, 100%);
  display: grid;
  gap: 34px;
}

.install-hero {
  text-align: center;
  display: grid;
  gap: 18px;
}

.install-kicker {
  margin: 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--tl-muted);
  font-size: 0.92rem;
}

.install-mark {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--tl-code);
  color: white;
  font-weight: 700;
}

.install-title {
  margin: 0;
  font-size: clamp(2.5rem, 7vw, 5.7rem);
  line-height: 0.92;
  letter-spacing: 0;
}

.install-copy {
  max-width: 760px;
  margin: 0 auto;
  color: var(--tl-muted);
  font-size: clamp(1.02rem, 2.1vw, 1.28rem);
  line-height: 1.55;
}

.command-list {
  width: min(840px, 100%);
  margin: 8px auto 0;
  display: grid;
  gap: 12px;
}

.command-panel {
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--tl-border);
  border-radius: 8px;
  background: var(--tl-panel);
  box-shadow: var(--tl-shadow);
  backdrop-filter: blur(12px);
}

.command-tabs {
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: rgba(11, 16, 32, 0.06);
}

.command-tab {
  border: 0;
  border-radius: 6px;
  padding: 8px 12px;
  background: transparent;
  color: var(--tl-muted);
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0;
  cursor: pointer;
  white-space: nowrap;
}

.command-tab[aria-selected="true"] {
  background: var(--tl-code);
  color: #fff;
}

.command-tab:focus-visible,
.copy-command:focus-visible {
  outline: 2px solid var(--tl-blue);
  outline-offset: 2px;
}

.command-field {
  position: relative;
  min-width: 0;
}

.command-line {
  margin: 0;
  min-width: 0;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--tl-command);
  color: var(--tl-ink);
  border: 1px solid rgba(17, 24, 39, 0.1);
  padding: 19px 64px 19px 20px;
  font-size: clamp(0.88rem, 2vw, 1.08rem);
  line-height: 1.4;
}

.command-line code {
  white-space: nowrap;
  color: inherit;
  background: transparent;
}

.copy-command {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--tl-blue);
  color: #fff;
  cursor: pointer;
  transform: translateY(-50%);
  transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  box-shadow: 0 8px 18px rgba(31, 111, 235, 0.22);
}

.copy-command:hover {
  transform: translateY(-50%) scale(1.03);
  background: #1559c8;
}

.copy-command:active {
  transform: translateY(-50%) scale(0.98);
}

.copy-command.copied {
  background: var(--tl-teal);
  box-shadow: 0 8px 18px rgba(15, 143, 134, 0.24);
}

.copy-command svg {
  width: 18px;
  height: 18px;
}

.copy-status {
  min-height: 22px;
  text-align: center;
  color: var(--tl-teal);
  font-size: 0.92rem;
}

.post-install {
  text-align: center;
  color: var(--tl-muted);
  font-size: 0.96rem;
}

.post-install code {
  background: rgba(11, 16, 32, 0.08);
  color: var(--tl-ink);
  border-radius: 5px;
  padding: 2px 5px;
}

.flow-strip {
  width: min(940px, 100%);
  margin: 10px auto 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.flow-step {
  min-height: 132px;
  padding: 16px;
  border: 1px solid var(--tl-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  text-align: left;
}

.flow-number {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  margin-bottom: 12px;
  background: var(--tl-code);
  color: #fff;
  font-weight: 700;
  font-size: 0.86rem;
}

.flow-step strong {
  display: block;
  font-size: 0.98rem;
  margin-bottom: 7px;
}

.flow-step p {
  margin: 0;
  color: var(--tl-muted);
  font-size: 0.92rem;
  line-height: 1.45;
}

.content-section {
  display: grid;
  gap: 20px;
}

.section-copy {
  max-width: 820px;
  margin: 0 auto;
  text-align: center;
}

.section-label {
  margin: 0 0 9px;
  color: var(--tl-teal);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.section-title {
  margin: 0;
  font-size: clamp(1.85rem, 4vw, 3rem);
  line-height: 1.05;
  letter-spacing: 0;
}

.section-copy p {
  margin: 14px auto 0;
  color: var(--tl-muted);
  font-size: 1.04rem;
  line-height: 1.62;
}

.principle-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.principle-card,
.example-card {
  border: 1px solid var(--tl-border);
  border-radius: 8px;
  background: var(--tl-panel);
  box-shadow: 0 16px 42px rgba(17, 24, 39, 0.08);
}

.principle-card {
  padding: 22px;
}

.principle-accent {
  width: 38px;
  height: 6px;
  border-radius: 999px;
  margin-bottom: 18px;
  background: var(--tl-lime);
}

.principle-card:nth-child(2) .principle-accent {
  background: var(--tl-blue);
}

.principle-card:nth-child(3) .principle-accent {
  background: var(--tl-amber);
}

.principle-card h3,
.example-card h3 {
  margin: 0;
  font-size: 1.08rem;
  line-height: 1.28;
  letter-spacing: 0;
}

.principle-card p {
  margin: 11px 0 0;
  color: var(--tl-muted);
  font-size: 0.97rem;
  line-height: 1.55;
}

.example-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.example-card {
  overflow: hidden;
}

.example-card h3 {
  padding: 18px 18px 0;
}

.example-card pre {
  margin: 16px 0 0;
  padding: 18px;
  min-height: 260px;
  background: var(--tl-code);
  color: #e5eef8;
  font-size: 0.84rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.example-card code {
  background: transparent;
  color: inherit;
}

@media (max-width: 760px) {
  .thinkless-install {
    padding: 44px 16px;
  }

  .install-title {
    font-size: clamp(2.25rem, 12vw, 3rem);
    line-height: 1;
  }

  .command-tabs {
    width: 100%;
  }

  .command-line {
    overflow-x: visible;
    padding: 16px 58px 16px 16px;
    font-size: 0.84rem;
    text-align: left;
  }

  .command-line code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .copy-command {
    width: 36px;
    height: 36px;
  }

  .flow-strip,
  .principle-grid,
  .example-grid {
    grid-template-columns: 1fr;
  }

  .flow-step {
    min-height: auto;
  }

  .section-copy {
    text-align: left;
  }

}
</style>

<main class="thinkless-install">
  <section class="install-shell" aria-labelledby="install-title">
    <div class="install-hero">
      <p class="install-kicker"><span class="install-mark">T</span> Thinkless install</p>
      <h1 id="install-title" class="install-title">Less thinking effort for AI software work.</h1>
      <p class="install-copy">Thinkless separates what you mean from how the work gets done. Say the goal in normal language; the system writes the plan, executes it with Codex, and keeps improving the plan as evidence arrives.</p>
      <div class="command-list" aria-label="Install command">
        <div class="command-panel" id="install-command-panel" role="group" aria-label="macOS and Linux install command">
          <div class="command-tabs" role="tablist" aria-label="Operating system">
            <button class="command-tab" id="install-tab-unix" type="button" role="tab" aria-selected="true" aria-controls="install-command-box" data-install-target="unix">macOS / Linux</button>
            <button class="command-tab" id="install-tab-windows" type="button" role="tab" aria-selected="false" aria-controls="install-command-box" data-install-target="windows" tabindex="-1">Windows</button>
          </div>
          <div class="command-field" id="install-command-box" role="tabpanel" aria-labelledby="install-tab-unix">
            <pre class="command-line"><code id="install-command">curl -fsSL https://wici.ai/thinkless/install.sh | bash</code></pre>
            <button class="copy-command" id="copy-install-command" type="button" onclick="copyInstallCommand(this, 'install-command')" aria-label="Copy macOS and Linux install command" title="Copy install command">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" stroke-width="2"></rect>
                <path d="M5 15V7a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div id="copy-status" class="copy-status" aria-live="polite"></div>
      <div class="flow-strip" aria-label="Thinkless workflow">
        <div class="flow-step">
          <span class="flow-number">1</span>
          <strong>Speak the intent</strong>
          <p>Use chat or dictation. The raw requirement stays visible instead of being polished into a fragile mega-prompt.</p>
        </div>
        <div class="flow-step">
          <span class="flow-number">2</span>
          <strong>Write the plan</strong>
          <p>Planner reasoning becomes GOAL.md, ASSUMPTIONS.md, and PLAN.md so the work is explicit and reviewable.</p>
        </div>
        <div class="flow-step">
          <span class="flow-number">3</span>
          <strong>Execute the loop</strong>
          <p>Codex reads the plan, edits the repo, runs checks, inspects failures, and continues without hand-holding.</p>
        </div>
        <div class="flow-step">
          <span class="flow-number">4</span>
          <strong>Steer forward</strong>
          <p>Follow-up messages update the live goal and plan. You correct by continuing the conversation.</p>
        </div>
      </div>
    </div>

    <p class="post-install">After installation, run <code>thinkless</code>, follow the Codex, Claude, and GitHub CLI auth prompts, then verify with <code>thinkless doctor --deep</code>.</p>

    <section class="content-section" aria-labelledby="philosophy-title">
      <div class="section-copy">
        <p class="section-label">Philosophy</p>
        <h2 id="philosophy-title" class="section-title">Think less at the keyboard. Reason better in the system.</h2>
        <p>Thinkless is not trying to remove judgment from software work. It removes the control labor that makes humans babysit agents: rewriting prompts, restating context, deciding every recovery command, and remembering why a path failed.</p>
      </div>
      <div class="principle-grid">
        <article class="principle-card">
          <div class="principle-accent"></div>
          <h3>Separate thinking from doing</h3>
          <p>Intent capture, planning, and execution are different modes. Thinkless keeps each mode in the right medium: conversation, markdown artifacts, and an agent execution loop.</p>
        </article>
        <article class="principle-card">
          <div class="principle-accent"></div>
          <h3>Treat submitted chat like speech</h3>
          <p>Submitted turns are append-only. You do not rewrite what you already said in a meeting; you clarify with the next sentence, preserving the record that lets the plan evolve honestly.</p>
        </article>
        <article class="principle-card">
          <div class="principle-accent"></div>
          <h3>Let plans improve with evidence</h3>
          <p>The first plan is a starting point, not a monument. Logs, tests, benchmarks, remote state, and user follow-ups should refine PLAN.md until the goal is genuinely handled.</p>
        </article>
      </div>
    </section>

    <section class="content-section" aria-labelledby="examples-title">
      <div class="section-copy">
        <p class="section-label">Examples</p>
        <h2 id="examples-title" class="section-title">Normal requests become durable coding work.</h2>
      </div>
      <div class="example-grid">
        <article class="example-card">
          <h3>Build an app</h3>
          <pre><code>You: Build a local dashboard for support triage and make sure it runs.

Thinkless: creates GOAL.md, ASSUMPTIONS.md, and PLAN.md, then Codex implements, validates, and reports evidence.

You: Also make the mobile view dense.

Thinkless: updates the existing plan and steers the active run.</code></pre>
        </article>
        <article class="example-card">
          <h3>Benchmark a remote target</h3>
          <pre><code>You: Try this model on the SSH host and see if it can reach 700 token/s.

Thinkless: records the performance target, plans discovery and measurement, then lets Codex handle docs, setup, logs, fallback paths, and the final result.</code></pre>
        </article>
        <article class="example-card">
          <h3>Fix a repo issue</h3>
          <pre><code>You: What is causing this test to fail?

Thinkless: answers directly when the task is bounded.

You: Fix it and harden the regression coverage.

Thinkless: escalates when the work becomes an implementation and validation loop.</code></pre>
        </article>
      </div>
    </section>
  </section>
</main>

<script>
function copyInstallCommand(button, commandId) {
  const command = document.getElementById(commandId).textContent.trim();
  const status = document.getElementById('copy-status');
  const writeFallback = function () {
    const textarea = document.createElement('textarea');
    textarea.value = command;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  };

  const markCopied = function () {
    button.classList.add('copied');
    status.textContent = 'Copied install command';
    window.clearTimeout(button.dataset.resetTimer);
    button.dataset.resetTimer = window.setTimeout(function () {
      button.classList.remove('copied');
      status.textContent = '';
    }, 1800);
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(command).then(markCopied, function () {
      writeFallback();
      markCopied();
    });
    return;
  }

  writeFallback();
  markCopied();
}

const installCommands = {
  unix: {
    command: 'curl -fsSL https://wici.ai/thinkless/install.sh | bash',
    panelLabel: 'macOS and Linux install command',
    copyLabel: 'Copy macOS and Linux install command',
    tabId: 'install-tab-unix'
  },
  windows: {
    command: 'irm https://wici.ai/thinkless/install.ps1 | iex',
    panelLabel: 'Windows install command',
    copyLabel: 'Copy Windows install command',
    tabId: 'install-tab-windows'
  }
};

function selectInstallCommand(target) {
  const selected = installCommands[target] || installCommands.unix;
  document.getElementById('install-command-panel').setAttribute('aria-label', selected.panelLabel);
  document.getElementById('install-command-box').setAttribute('aria-labelledby', selected.tabId);
  document.getElementById('install-command').textContent = selected.command;
  document.getElementById('copy-install-command').setAttribute('aria-label', selected.copyLabel);

  document.querySelectorAll('[data-install-target]').forEach(function (tab) {
    const isSelected = tab.dataset.installTarget === target;
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    tab.tabIndex = isSelected ? 0 : -1;
  });
}

function detectInstallTarget() {
  const platform =
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform ||
    navigator.userAgent ||
    '';

  return /win/i.test(platform) ? 'windows' : 'unix';
}

function handleInstallTabKeydown(event) {
  const tabs = Array.from(document.querySelectorAll('[data-install-target]'));
  const index = tabs.indexOf(event.currentTarget);
  let nextIndex = null;

  if (event.key === 'ArrowRight') {
    nextIndex = (index + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (index - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  }

  if (nextIndex === null) {
    return;
  }

  event.preventDefault();
  tabs[nextIndex].focus();
  selectInstallCommand(tabs[nextIndex].dataset.installTarget);
}

function configureInstallCommand() {
  document.querySelectorAll('[data-install-target]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      selectInstallCommand(tab.dataset.installTarget);
    });
    tab.addEventListener('keydown', handleInstallTabKeydown);
  });

  selectInstallCommand(detectInstallTarget());
}

configureInstallCommand();
</script>
