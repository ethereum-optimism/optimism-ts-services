/* Imports: External */
import { Contract, Signer } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { SecureTrie } from 'merkle-patricia-tree'
import * as rlp from 'rlp'

/* Imports: Internal */
import { BaseService } from './base.service'
import { StateDiffProof, StateTransitionPhase, FraudProofData } from '../types'
import {
  sleep,
  ZERO_ADDRESS,
  loadContract,
  loadContractFromManager,
  loadProxyFromManager,
  L1ProviderWrapper,
  L2ProviderWrapper,
  toHexString,
  fromHexString,
  encodeAccountState,
  decodeAccountState,
} from '../utils'

interface FraudProverOptions {
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider
  addressManagerAddress: string
  l1Wallet: Signer
  deployGasLimit: number
  pollingInterval: number
  fromL2TransactionIndex: number
  l2BlockOffset: number
}

export const updateAndProve = async (
  trie: SecureTrie,
  key: Buffer,
  value: Buffer
): Promise<string> => {
  const proof = await SecureTrie.createProof(trie, key)
  const encodedProof = toHexString(rlp.encode(proof))
  await trie.put(key, value)
  return encodedProof
}

export class FraudProverService extends BaseService<FraudProverOptions> {
  protected name = 'Fraud Prover'
  protected defaultOptions = {
    pollingInterval: 5000,
    deployGasLimit: 4_000_000,
    fromL2TransactionIndex: 0,
    l2BlockOffset: 1,
  }

  private state: {
    nextUnverifiedStateRoot: number
    l1Provider: L1ProviderWrapper
    l2Provider: L2ProviderWrapper
    Lib_AddressManager: Contract
    OVM_StateCommitmentChain: Contract
    OVM_CanonicalTransactionChain: Contract
    OVM_FraudVerifier: Contract
  }

  protected async _init(): Promise<void> {
    // Need to improve this, sorry.
    this.state = {} as any

    this.state.Lib_AddressManager = loadContract(
      'Lib_AddressManager',
      this.options.addressManagerAddress,
      this.options.l1RpcProvider
    )

    this.logger.info('Connecting to OVM_StateCommitmentChain...')
    this.state.OVM_StateCommitmentChain = await loadContractFromManager(
      'OVM_StateCommitmentChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_StateCommitmentChain at address: ${this.state.OVM_StateCommitmentChain.address}`
    )

    this.logger.info('Connecting to OVM_CanonicalTransactionChain...')
    this.state.OVM_CanonicalTransactionChain = await loadContractFromManager(
      'OVM_CanonicalTransactionChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_CanonicalTransactionChain at address: ${this.state.OVM_CanonicalTransactionChain.address}`
    )

    this.logger.info('Connecting to OVM_FraudVerifier...')
    this.state.OVM_FraudVerifier = await loadContractFromManager(
      'OVM_FraudVerifier',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_FraudVerifier at address: ${this.state.OVM_FraudVerifier.address}`
    )

    this.logger.success('Connected to all contracts.')

    this.state.l1Provider = new L1ProviderWrapper(
      this.options.l1RpcProvider,
      this.state.OVM_StateCommitmentChain,
      this.state.OVM_CanonicalTransactionChain
    )
    this.state.l2Provider = new L2ProviderWrapper(this.options.l2RpcProvider)

    this.state.nextUnverifiedStateRoot = this.options.fromL2TransactionIndex || 0
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {
        this.logger.info(`Retrieving batch header for state root index: ${this.state.nextUnverifiedStateRoot}`)
        let nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
          this.state.nextUnverifiedStateRoot
        )

        let transactionIndex: number = undefined
        while (nextStateBatchHeader !== undefined) {
          const nextBatchStateRoots = await this.state.l1Provider.getBatchStateRoots(
            this.state.nextUnverifiedStateRoot
          )

          this.logger.info(`Checking for any mismatched state roots...`)
          for (let i = 0; i < nextStateBatchHeader.batchSize.toNumber(); i++) {
            const l1StateRoot = nextBatchStateRoots[i]
            const l1StateRootIndex = this.state.nextUnverifiedStateRoot + i

            this.logger.info(`Checking state root for mismatch: ${l1StateRootIndex}`)
            const l2StateRoot = await this.state.l2Provider.getStateRoot(
              l1StateRootIndex + this.options.l2BlockOffset
            )

            if (l1StateRoot !== l2StateRoot) {
              transactionIndex = l1StateRootIndex
              this.logger.interesting(`Found a mismatched state root at index ${transactionIndex}!`)
              this.logger.interesting(`State root published to Layer 1 was: ${l1StateRoot}`)
              this.logger.interesting(`State root published to Layer 2 was: ${l2StateRoot}`)
              this.logger.interesting(`Starting the fraud proof process...`)
              break
            } else {
              this.logger.info(`No state root mismatch, checking the next root.`)
            }
          }

          if (transactionIndex === undefined) {
            this.state.nextUnverifiedStateRoot += nextStateBatchHeader.batchSize.toNumber()
          }

          this.logger.info(`Moving on to the next batch, starting with state root index: ${this.state.nextUnverifiedStateRoot}`)
          nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
            this.state.nextUnverifiedStateRoot
          )
        }

        if (transactionIndex === undefined) {
          this.logger.info(`Didn't find any mismatched state roots. Trying again in ${Math.floor(this.options.pollingInterval / 1000)} seconds...`)
          continue
        }

        // 1. Retrieve proof data for the given state root.
        const proof = await this._getTxFraudProofData(transactionIndex)

        // 2. Check whether the fraud proof process has already been started for that root.
        let stateTransitionerAddress = await this._getStateTransitioner(
          transactionIndex
        )

        // 3. If not, start the fraud proof process.
        if (stateTransitionerAddress === ZERO_ADDRESS) {
          await this._initializeFraudVerification(proof)
          stateTransitionerAddress = await this._getStateTransitioner(
            transactionIndex
          )
        }

        const OVM_StateTransitioner = loadContract(
          'OVM_StateTransitioner',
          stateTransitionerAddress,
          this.options.l1RpcProvider
        )

        const stateManagerAddress = await OVM_StateTransitioner.stateManager()
        const OVM_StateManager = loadContract(
          'OVM_StateManager',
          stateManagerAddress,
          this.options.l1RpcProvider
        )

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.PRE_EXECUTION
        ) {
          // 4. Use proof data to populate the state transitioner. (+ deploy contracts)
          for (const account of proof.proof.accounts) {
            const code = await this.options.l2RpcProvider.getCode(
              account.address
            )
            const ethContractAddress = await this._deployContractCode(code)
            await OVM_StateTransitioner.proveContractState(
              account.address,
              ethContractAddress,
              {
                nonce: account.nonce,
                balance: account.balance,
                storageRoot: account.storageHash,
                codeHash: account.codeHash,
              },
              rlp.encode(account.accountProof)
            )

            // TODO: Empty accounts?

            for (const slot of account.storageProof) {
              await OVM_StateTransitioner.proveStorageSlot(
                account.address,
                slot.key,
                slot.value,
                rlp.encode(slot.proof)
              )
            }
          }

          // 5. Execute the transaction.
          await OVM_StateTransitioner.applyTransaction(proof.transaction)
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.POST_EXECUTION
        ) {
          // 6. Update all of the modified storage slots and accounts.
          const mutatedAccounts = proof.proof.accounts.filter((account) => {
            return account.mutated
          })

          for (const account of mutatedAccounts) {
            const newAccount = await OVM_StateManager.getAccount(
              account.address
            )

            const oldAccountState = decodeAccountState(
              await proof.stateTrie.get(fromHexString(account.address))
            )

            const updateProof = await updateAndProve(
              proof.stateTrie,
              fromHexString(account.address),
              encodeAccountState({
                ...oldAccountState,
                ...{
                  nonce: newAccount.nonce.toNumber(),
                  codeHash: newAccount.codeHash,
                },
              })
            )

            await OVM_StateTransitioner.commitContractState(
              account.address,
              updateProof,
              {
                gasLimit: this.options.deployGasLimit,
              }
            )

            const mutatedSlots = account.storageProof.filter((slot) => {
              return slot.mutated
            })

            for (const slot of mutatedSlots) {
              const trie = proof.storageTries[account.address]

              const updatedSlotValue = await OVM_StateManager.getContractStorage(
                account.address,
                slot.key
              )

              const storageTrieProof = await updateAndProve(
                trie,
                fromHexString(slot.key),
                fromHexString(updatedSlotValue)
              )

              const oldAccountState = decodeAccountState(
                await proof.stateTrie.get(fromHexString(account.address))
              )

              const newAccountState = {
                ...oldAccountState,
                storageRoot: toHexString(trie.root),
              }

              const stateTrieProof = await updateAndProve(
                proof.stateTrie,
                fromHexString(account.address),
                encodeAccountState(newAccountState)
              )

              await OVM_StateTransitioner.commitStorageSlot(
                account.address,
                slot.key,
                stateTrieProof,
                storageTrieProof,
                {
                  gasLimit: this.options.deployGasLimit,
                }
              )
            }
          }

          // 7. Complete the process in the state transitioner.
          await OVM_StateTransitioner.completeTransition()
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.COMPLETE
        ) {
          // 8. Finalize the process in the fraud verifier.
          await this._finalizeFraudVerification(proof)
        }
      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  private async _getTxFraudProofData(
    transactionIndex: number
  ): Promise<FraudProofData> {
    const proof: StateDiffProof = await this.state.l2Provider.getStateDiffProof(
      transactionIndex
    )

    const preStateRootIndex = transactionIndex
    const preStateRoot = await this.state.l2Provider.getStateRoot(
      preStateRootIndex
    )
    const preStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      preStateRootIndex
    )

    const postStateRootIndex = transactionIndex + 1
    const postStateRoot = await this.state.l2Provider.getStateRoot(
      postStateRootIndex
    )
    const postStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      postStateRootIndex
    )

    const transaction = await this.state.l2Provider.getTransaction(
      transactionIndex
    )
    const transactionProof = await this.state.l1Provider.getTransactionBatchProof(
      transactionIndex
    )

    const stateTrie = await this._makeStateTrie(proof)
    const storageTries = await this._makeAccountTries(proof)

    return {
      proof,
      transaction,
      transactionIndex,
      transactionProof,
      preStateRoot,
      preStateRootIndex,
      preStateRootProof,
      postStateRoot,
      postStateRootIndex,
      postStateRootProof,
      stateTrie,
      storageTries,
    }
  }

  private async _makeStateTrie(proof: StateDiffProof): Promise<SecureTrie> {
    const firstRootNode = proof.accounts[0].accountProof[0]
    const allNonRootNodes: string[] = proof.accounts.reduce(
      (nodes, account) => {
        return nodes.concat(account.accountProof.slice(1))
      },
      []
    )
    const allNodes = [firstRootNode].concat(allNonRootNodes).map((el) => {
      return Buffer.from(el.slice(2), 'hex')
    })

    return new SecureTrie((await SecureTrie.fromProof(allNodes)).db)
  }

  private async _makeAccountTries(
    proof: StateDiffProof
  ): Promise<{
    [address: string]: SecureTrie
  }> {
    const witnessMap = proof.accounts.reduce(
      (
        map: {
          [address: string]: Buffer[]
        },
        account
      ) => {
        const ovmContractAddress = account.address
        if (!(ovmContractAddress in map)) {
          map[ovmContractAddress] = [
            Buffer.from(account.storageHash.slice(2), 'hex'),
          ]
        }

        map[ovmContractAddress] = map[ovmContractAddress].concat(
          account.storageProof.reduce((nodes, storageProof) => {
            return nodes.concat(storageProof.proof.slice(1))
          }, [])
        )
        return map
      },
      {}
    )

    const accountTries = {}
    for (const ovmContractAddress of Object.keys(witnessMap)) {
      const proof = witnessMap[ovmContractAddress]
      accountTries[ovmContractAddress] = new SecureTrie(
        (await SecureTrie.fromProof(proof)).db
      )
    }

    return accountTries
  }

  private async _getStateTransitioner(
    transactionIndex: number
  ): Promise<string> {
    return this.state.OVM_FraudVerifier.stateTransitioners(transactionIndex)
  }

  private async _deployContractCode(code: string): Promise<string> {
    const prefix = '0x38600D0380600D6000396000f3'
    const deployCode = prefix + code.slice(2)
    const response = await this.options.l1Wallet.sendTransaction({
      to: null,
      data: deployCode,
      gasLimit: this.options.deployGasLimit,
    })

    const result = await response.wait()
    return result.contractAddress
  }

  private async _initializeFraudVerification(
    proof: FraudProofData
  ): Promise<void> {
    await this.state.OVM_FraudVerifier.initializeFraudVerification(
      proof.preStateRootProof.stateRoot,
      proof.preStateRootProof.stateRootBatchHeader,
      proof.preStateRootProof.stateRootProof,
      proof.transactionProof.transaction,
      proof.transactionProof.transaction, // TODO:????
      proof.transactionProof.transactionBatchHeader,
      proof.transactionProof.transactionProof
    )
  }

  private async _finalizeFraudVerification(
    proof: FraudProofData
  ): Promise<void> {
    await this.state.OVM_FraudVerifier.finalizeFraudVerification(
      proof.preStateRootProof.stateRoot,
      proof.preStateRootProof.stateRootBatchHeader,
      proof.preStateRootProof.stateRootProof,
      proof.postStateRootProof.stateRoot,
      proof.postStateRootProof.stateRootBatchHeader,
      proof.postStateRootProof.stateRootProof
    )
  }
}
