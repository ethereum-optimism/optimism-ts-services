/* Imports: Internal */
import { Logger } from '../utils/logger'

/**
 * Base for other "Service" objects. Handles your standard initialization process, can dynamically
 * start and stop.
 */
export class BaseService<TServiceOptions> {
  protected name: string
  protected logger: Logger
  protected initialized: boolean = false
  protected running: boolean = false

  /**
   * @param options Options to pass to the service.
   */
  constructor(protected options: TServiceOptions) {}

  /**
   * Initializes the service.
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.initialized = true
    this.logger = new Logger(this.name)

    try {
      this.logger.status('Service is initializing...')
      await this._init()
      this.logger.status('Service has initialized.')
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
    this.logger = new Logger(this.name)

    this.logger.status('Service is starting...')
    await this.init()
    await this._start()
    this.logger.status('Service has started')
  }

  /**
   * Stops the service.
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.logger.status('Service is stopping...')
    await this._stop()
    this.logger.status('Service has stopped')

    this.running = false
  }

  /**
   * Internal init function. Parent should implement.
   */
  protected async _init(): Promise<void> {}

  /**
   * Internal start function. Parent should implement.
   */
  protected async _start(): Promise<void> {}

  /**
   * Internal stop function. Parent should implement.
   */
  protected async _stop(): Promise<void> {}
}
