---
title: Install Thinkless
---

# Install Thinkless

Thinkless reduces the thinking effort of AI software development: it sets up the local tools, connects Codex, Claude, and GitHub CLI, and gives you one command for planning and building software with AI.

<div>
  <pre><code id="install-command">curl -fsSL https://wiseide.ai/docs/install.sh | bash</code></pre>
  <button type="button" onclick="copyInstallCommand()">Copy</button>
</div>

<script>
function copyInstallCommand() {
  const text = document.getElementById('install-command').textContent.trim();
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
</script>

After installation, run `thinkless`, then follow the Codex, Claude, and GitHub CLI auth prompts. Run `thinkless doctor --deep` to verify the setup.
