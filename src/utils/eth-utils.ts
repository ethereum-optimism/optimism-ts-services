import * as rlp from 'rlp'
import { BigNumber, Contract } from 'ethers'
import { Account, BN } from 'ethereumjs-util'

import { toHexString, fromHexString } from './hex-utils'

export const encodeAccountState = (state: Partial<any>): Buffer => {
  return new Account(
    new BN(state.nonce),
    new BN(state.balance.toNumber()),
    fromHexString(state.storageRoot),
    fromHexString(state.codeHash)
  ).serialize()
}

export const decodeAccountState = (state: Buffer): any => {
  const account = Account.fromRlpSerializedAccount(state)
  return {
    nonce: account.nonce.toNumber(),
    balance: BigNumber.from(account.nonce.toNumber()),
    storageRoot: toHexString(account.stateRoot),
    codeHash: toHexString(account.codeHash),
  }
}

export const smartSendTransaction = async (options: {
  contract: Contract,
  functionName: string,
  args?: any[],
  acceptableErrors?: string[]
}): Promise<void> => {
  try {
    await (
      await options.contract[options.functionName](...(options.args || []))
    ).wait()
  } catch (err) {
    try {
      await options.contract.callStatic[options.functionName](...(options.args || []))
    } catch (err) {
      if (!(options.acceptableErrors && options.acceptableErrors.some((acceptableError) => {
        return err.toString().includes(acceptableError)
      }))) {
        throw err
      }
    }
  }
}
