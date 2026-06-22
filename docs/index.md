---
title: Install Thinkless
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
  --tl-shadow: 0 24px 70px rgba(17, 24, 39, 0.14);
  --tl-code: #0b1020;
  --tl-command: #f8fafc;
}

body {
  margin: 0;
  background:
    linear-gradient(180deg, #f8fafc 0%, #eef4f2 52%, #f7f7fb 100%);
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
  place-items: center;
  padding: 64px 22px;
  box-sizing: border-box;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.install-shell {
  width: min(1060px, 100%);
  display: grid;
  gap: 22px;
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

.command-panel {
  width: min(840px, 100%);
  margin: 8px auto 0;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--tl-border);
  border-radius: 8px;
  background: var(--tl-panel);
  box-shadow: var(--tl-shadow);
  backdrop-filter: blur(12px);
}

.command-line {
  margin: 0;
  min-width: 0;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--tl-command);
  color: var(--tl-ink);
  border: 1px solid rgba(17, 24, 39, 0.1);
  padding: 19px 20px;
  font-size: clamp(0.88rem, 2vw, 1.08rem);
  line-height: 1.4;
}

.command-line code {
  white-space: nowrap;
  color: inherit;
  background: transparent;
}

.copy-command {
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--tl-blue);
  color: #fff;
  cursor: pointer;
  transition: transform 160ms ease, background 160ms ease, box-shadow 160ms ease;
  box-shadow: 0 12px 24px rgba(31, 111, 235, 0.26);
}

.copy-command:hover {
  transform: translateY(-1px);
  background: #1559c8;
}

.copy-command:active {
  transform: translateY(0) scale(0.98);
}

.copy-command.copied {
  background: var(--tl-teal);
  box-shadow: 0 12px 24px rgba(15, 143, 134, 0.24);
}

.copy-command svg {
  width: 22px;
  height: 22px;
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

@media (max-width: 760px) {
  .thinkless-install {
    padding: 44px 16px;
  }

  .install-title {
    font-size: clamp(2.25rem, 12vw, 3rem);
    line-height: 1;
  }

  .command-panel {
    grid-template-columns: 1fr;
  }

  .command-line {
    overflow-x: visible;
    padding: 16px;
    font-size: 0.84rem;
    text-align: left;
  }

  .command-line code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .copy-command {
    width: 100%;
  }

}
</style>

<main class="thinkless-install">
  <section class="install-shell" aria-labelledby="install-title">
    <div class="install-hero">
      <p class="install-kicker"><span class="install-mark">T</span> Thinkless install</p>
      <h1 id="install-title" class="install-title">Less thinking effort for AI software work.</h1>
      <p class="install-copy">Thinkless sets up the local tools, connects Codex, Claude Code, and GitHub CLI, then gives you one command to move from idea to working software.</p>
      <div class="command-panel" role="group" aria-label="Install command">
        <pre class="command-line"><code id="install-command">curl -fsSL https://wici.ai/thinkless/install.sh | bash</code></pre>
        <button class="copy-command" type="button" onclick="copyInstallCommand(this)" aria-label="Copy install command" title="Copy install command">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" stroke-width="2"></rect>
            <path d="M5 15V7a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          </svg>
        </button>
      </div>
      <div id="copy-status" class="copy-status" aria-live="polite"></div>
    </div>

    <p class="post-install">After installation, run <code>thinkless</code>, follow the Codex, Claude, and GitHub CLI auth prompts, then verify with <code>thinkless doctor --deep</code>.</p>
  </section>
</main>

<script>
function copyInstallCommand(button) {
  const command = document.getElementById('install-command').textContent.trim();
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
</script>
