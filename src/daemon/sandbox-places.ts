// B29: places under your home that run later, outside any sandbox: shell startup files, login items, SSH and git's global
// config, Claude Code's and Codex's folders. The agent's bash may not write them, even in Don't ask. Linux's autostart
// and systemd user units are the same kind of place.
export const PERSISTENCE_FILES: readonly string[] = ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.gitconfig', '.claude.json'];
export const PERSISTENCE_DIRS: readonly string[] = ['.config/fish', 'Library/LaunchAgents', '.ssh', '.config/git', '.claude', '.codex', '.config/autostart', '.config/systemd/user', '.config/environment.d'];
