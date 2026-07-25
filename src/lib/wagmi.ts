import { createConfig, http } from 'wagmi'
import { coinbaseWallet } from 'wagmi/connectors/coinbaseWallet'
import { walletConnect } from 'wagmi/connectors/walletConnect'
import { robinhoodChain } from './chain'
import { BRAND } from '../config'

/**
 * Get one at https://cloud.reown.com and put it in `.env.local` as
 * VITE_WALLETCONNECT_PROJECT_ID. Without it the WalletConnect option is
 * shown but disabled, rather than crashing at connect time.
 */
export const walletConnectProjectId = import.meta.env
  .VITE_WALLETCONNECT_PROJECT_ID as string | undefined

export const hasWalletConnect = Boolean(walletConnectProjectId)

/**
 * Browser-extension wallets (MetaMask, Rabby, Coinbase extension, …) are
 * discovered automatically over EIP-6963, so they need no connector here —
 * wagmi surfaces each one it finds with its real name and icon.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  multiInjectedProviderDiscovery: true,
  connectors: [
    coinbaseWallet({ appName: BRAND.name, preference: { options: 'all' } }),
    ...(walletConnectProjectId
      ? [
          walletConnect({
            projectId: walletConnectProjectId,
            showQrModal: true,
            metadata: {
              name: BRAND.name,
              description: BRAND.tagline,
              url: BRAND.url,
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [robinhoodChain.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
