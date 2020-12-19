import { Contract, Signer } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { getContractInterface } from '@eth-optimism/contracts/build/src/contract-defs'

import { ZERO_ADDRESS } from './constants'

export const loadContract = (
  name: string,
  address: string,
  provider: JsonRpcProvider
): Contract => {
  return new Contract(address, getContractInterface(name) as any, provider)
}

export const loadContractFromManager = async (
  name: string,
  Lib_AddressManager: Contract,
  provider: JsonRpcProvider
): Promise<Contract> => {
  const address = await Lib_AddressManager.getAddress(name)

  if (address === ZERO_ADDRESS) {
    throw new Error(
      `Lib_AddressManager does not have a record for a contract named: ${name}`
    )
  }

  return loadContract(name, address, provider)
}

export const loadProxyFromManager = async (
  name: string,
  proxy: string,
  Lib_AddressManager: Contract,
  provider: JsonRpcProvider
): Promise<Contract> => {
  const address = await Lib_AddressManager.getAddress(proxy)

  if (address === ZERO_ADDRESS) {
    throw new Error(
      `Lib_AddressManager does not have a record for a contract named: ${proxy}`
    )
  }

  return loadContract(name, address, provider)
}

const loadAddressManager = async (
  l1RpcProvider: JsonRpcProvider,
  l2RpcProvider: JsonRpcProvider
): Promise<Contract> => {
  const addressManagerAddress = (await l2RpcProvider.send('rollup_getInfo', []))
    .addresses.addressResolver

  return loadContract(
    'Lib_AddressManager',
    addressManagerAddress,
    l1RpcProvider
  )
}

export interface OptimismContracts {
  OVM_StateCommitmentChain: Contract
  OVM_CanonicalTransactionChain: Contract
  OVM_FraudVerifier: Contract
  OVM_ExecutionManager: Contract
}

export const loadOptimismContracts = async (
  l1RpcProvider: JsonRpcProvider,
  l2RpcProvider: JsonRpcProvider,
  signer: Signer
): Promise<OptimismContracts> => {
  const Lib_AddressManager = await loadAddressManager(
    l1RpcProvider,
    l2RpcProvider
  )

  const inputs = [
    {
      name: 'OVM_StateCommitmentChain',
      interface: 'iOVM_StateCommitmentChain',
    },
    {
      name: 'OVM_CanonicalTransactionChain',
      interface: 'iOVM_CanonicalTransactionChain',
    },
    {
      name: 'OVM_FraudVerifier',
      interface: 'iOVM_FraudVerifier',
    },
    {
      name: 'OVM_ExecutionManager',
      interface: 'iOVM_ExecutionManager',
    },
  ]

  const contracts = {}
  for (const input of inputs) {
    contracts[input.name] = (
      await loadProxyFromManager(
        input.interface,
        input.name,
        Lib_AddressManager,
        l1RpcProvider
      )
    ).connect(signer)
  }

  // TODO: sorry
  return contracts as OptimismContracts
}
