export interface Notifier {
  notifyPatientOrderReady(orderId: number): Promise<void>
}

export class ConsoleNotifier implements Notifier {
  async notifyPatientOrderReady(orderId: number) {
    console.log(`[notifier] order ${orderId} is ready for patient payment`)
  }
}

/** Records notifications instead of logging; for tests. */
export class RecordingNotifier implements Notifier {
  readonly sent: number[] = []

  async notifyPatientOrderReady(orderId: number) {
    this.sent.push(orderId)
  }
}
