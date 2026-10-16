// electron-builder's config for the desktop app, per system. macOS: a dir and zip with the notification helper and the
// `ai` launchers (ad-hoc signed). Linux (v0.8.1): an AppImage and a .deb. Windows (v0.8.2): an NSIS installer. Nothing
// is signed with a real identity: no certificates are looked up or used.
import { join } from 'node:path';
export function appBuilderConfig({ platform, root, out, version, arch }) {
  const base = { appId: 'local.aiterm.desktop', productName: 'AI Term', asar: false, npmRebuild: false, electronVersion: version, electronDist: join(root, 'node_modules/electron/dist'), directories: { output: join(out, 'dist') }, files: ['app/out/**/*', 'dist/**/*', 'data/**/*', 'addons/**/*', 'package.json'] };
  if (platform === 'linux') return { ...base, extraFiles: [], linux: { target: [{ target: 'AppImage', arch: [arch] }, { target: 'deb', arch: [arch] }], category: 'Development', maintainer: 'AI Term <ai-term@localhost>', artifactName: 'AI-Term-${version}-${arch}.${ext}' } };
  if (platform === 'win32') return { ...base, extraFiles: [], win: { target: [{ target: 'nsis', arch: [arch] }], artifactName: 'AI-Term-Setup-${version}-${arch}.${ext}' }, nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true } };
  return { ...base, extraFiles: [{ from: join(root, 'build/notifier/AI Term.app'), to: 'Helpers/AI Term.app' }], mac: { target: [{ target: 'dir', arch: [arch] }, { target: 'zip', arch: [arch] }], identity: '-', hardenedRuntime: false, notarize: false, gatekeeperAssess: false, artifactName: 'AI-Term-${version}-${arch}.${ext}' } };
}
