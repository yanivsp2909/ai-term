// B29: places under your home that run later, outside any sandbox: shell startup files, login items, SSH and git's global
// config, Claude Code's and Codex's folders. The agent's bash may not write them, even in Don't ask. Linux's autostart
// and systemd user units are the same kind of place.
export const PERSISTENCE_FILES: readonly string[] = ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.gitconfig', '.claude.json',
  // Linux session and login files, and gpg-agent's config, which names a program it runs (security review).
  '.xprofile', '.xsessionrc', '.xinitrc', '.pam_environment', '.gnupg/gpg-agent.conf',
  // Ubuntu's .bashrc sources it (gate).
  '.bash_aliases'];
export const PERSISTENCE_DIRS: readonly string[] = ['.config/fish', 'Library/LaunchAgents', '.ssh', '.config/git', '.claude', '.codex', '.config/autostart', '.config/systemd/user', '.config/environment.d',
  // Linux: user units in ~/.local/share override enabled system ones without being enabled; desktop and window-manager
  // autostart. Not ~/.local/bin or ~/bin: the agent installs tools there (Yaniv, 2026-10-15), so a program planted in a
  // PATH folder in home can still run as you later.
  '.local/share/systemd/user', '.config/plasma-workspace/env', '.config/autostart-scripts', '.config/i3', '.config/sway', '.config/hypr', '.config/openbox',
  // oh-my-zsh loads custom/*.zsh at every shell; D-Bus starts a service file's program on demand (gate).
  '.oh-my-zsh/custom', '.local/share/dbus-1/services'];
