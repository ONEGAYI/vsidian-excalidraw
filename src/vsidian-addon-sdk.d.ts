declare module 'vsidian-addon-sdk' {
  export function defineAddonPage<Sdk>(addonId: string, factory: (sdk: Sdk) => void): void
}
