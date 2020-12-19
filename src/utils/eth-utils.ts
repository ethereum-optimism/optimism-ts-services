/* Imports: External */
import { BigNumber, Contract } from 'ethers'
import { Account, BN } from 'ethereumjs-util'

/* Imports: Internal */
import { sleep } from './common'
import { toHexString, fromHexString } from './hex-utils'
import { JsonRpcProvider } from '@ethersproject/providers'

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

export const waitForNetwork = async (
  provider: JsonRpcProvider,
  name: string,
  logger: any
): Promise<void> => {
  logger.info(`Trying to connect to network: ${name}...`)

  for (let i = 0; i < 10; i++) {
    try {
      await provider.detectNetwork()
      logger.info(`Successfully connected to network: ${name}.`)
      break
    } catch (err) {
      if (i < 9) {
        logger.info(
          `Unable to connect network: ${name}, will try ${
            10 - i
          } more time(s)...`
        )
        await sleep(1000)
      } else {
        throw new Error(
          `Unable to connect to network: ${name}, check that your endpoint is correct.`
        )
      }
    }
  }
}

export const smartSendTransaction = async ({
  contract,
  functionName,
  functionParams = [],
  acceptableErrors = [],
  logger,
}: {
  contract: Contract
  functionName: string
  functionParams?: any[]
  acceptableErrors?: Array<{
    errors: string[]
    reason: string
  }>
  logger?: any
}): Promise<void> => {
  try {
    await await contract[functionName](...functionParams).wait()
  } catch (err) {
    try {
      await contract.callStatic[functionName](...functionParams)
    } catch (err) {
      for (const acceptableError of acceptableErrors) {
        for (const error of acceptableError.errors) {
          if (err.toString().includes(error)) {
            if (logger) {
              logger.info(acceptableError.reason)
            }

            return
          }
        }
      }

      throw err
    }
  }
}
