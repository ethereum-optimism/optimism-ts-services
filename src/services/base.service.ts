/* Imports: Internal */
import { Logger } from '@eth-optimism/core-utils'

/**
 * Base for other "Service" objects. Handles your standard initialization process, can dynamically
 * start and stop.
 */
export class BaseService<TServiceOptions> {
  protected name: string
  protected defaultOptions: Partial<TServiceOptions>
  protected logger: Logger
  protected initialized: boolean = false
  protected running: boolean = false

  /**
   * @param options Options to pass to the service.
   */
  constructor(protected options: TServiceOptions) {
    this.options = {
      ...this.defaultOptions,
      ...this.options,
    }
  }

  /**
   * Initializes the service.
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.initialized = true
    this.logger = new Logger({ name: this.name })

    try {
      this.logger.info('Service is initializing...')
      await this._init()
      this.logger.info('Service has initialized.')
    } catch (err) {
      this.initialized = false
      throw err
    }
  }

  /**
   * Starts the service.
   */
  public async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    this.logger = new Logger({ name: this.name })

    this.logger.info('Service is starting...')
    await this.init()
    await this._start()
    this.logger.info('Service has started')
  }

  /**
   * Stops the service.
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.logger.info('Service is stopping...')
    await this._stop()
    this.logger.info('Service has stopped')

    this.running = false
  }

  /**
   * Internal init function. Parent should implement.
   */
  protected async _init(): Promise<void> {
    return
  }

  /**
   * Internal start function. Parent should implement.
   */
  protected async _start(): Promise<void> {
    return
  }

  /**
   * Internal stop function. Parent should implement.
   */
  protected async _stop(): Promise<void> {
    return
  }
}
