import { useState } from 'react'
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi'
import { robinhoodChain } from '../lib/chain'
import { WalletModal } from './WalletModal'

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

export function ConnectButton() {
  const [open, setOpen] = useState(false)
  // `useAccount().chainId` is the network the wallet is actually on.
  // `useChainId()` would report the config's chain and never disagree.
  const { address, isConnected, chainId } = useAccount()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switching } = useSwitchChain()

  const wrongNetwork = isConnected && chainId !== robinhoodChain.id

  return (
    <>
      {!isConnected ? (
        <button className="btn btn--dark" onClick={() => setOpen(true)}>
          Connect Wallet
        </button>
      ) : wrongNetwork ? (
        <button
          className="wrong-net"
          onClick={() => switchChain({ chainId: robinhoodChain.id })}
          disabled={switching}
        >
          {switching ? 'Switching…' : `Switch to ${robinhoodChain.name}`}
        </button>
      ) : (
        <div className="account">
          <span className="account__dot" />
          <span>{short(address!)}</span>
          <button className="account__disconnect" onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      )}

      <WalletModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
