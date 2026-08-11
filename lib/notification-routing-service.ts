import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import {
  applyNotificationRoutingPlan,
  createNotificationRoutingReceipt,
  planNotificationRouting,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type NotificationRoutingPlan,
  type NotificationRoutingReceipt,
} from '../utils/notification-routing.ts';
import type NotificationRoutingReceiptStore from './notification-routing-receipt-store.ts';

export interface NotificationRoutingServiceDependencies {
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  receiptStore: Pick<NotificationRoutingReceiptStore, 'read' | 'remove' | 'write'>;
}

export interface NotificationRoutingReconcileResult {
  configChanged: boolean;
  plan: NotificationRoutingPlan;
  receiptAction: 'created' | 'none' | 'removed';
}

function assertSafePlan(plan: NotificationRoutingPlan): void {
  if (plan.kind === 'conflict') throw new Error(plan.message);
}

/** Inspect and reconcile one manifest-owned account-scoped notification route. */
export default class NotificationRoutingService {
  readonly #dependencies: NotificationRoutingServiceDependencies;

  constructor(dependencies: NotificationRoutingServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(desired: NotificationRoutingDesiredState): Promise<NotificationRoutingPlan> {
    const [config, receipt] = await Promise.all([
      this.#dependencies.readConfig(),
      this.#dependencies.receiptStore.read(desired.agentId),
    ]);
    return planNotificationRouting(config, desired, receipt);
  }

  async reconcile(
    desired: NotificationRoutingDesiredState,
  ): Promise<NotificationRoutingReconcileResult> {
    const receipt = await this.#dependencies.receiptStore.read(desired.agentId);
    const initialPlan = planNotificationRouting(
      await this.#dependencies.readConfig(),
      desired,
      receipt,
    );
    assertSafePlan(initialPlan);

    let configChanged = false;
    if (initialPlan.kind === 'remove' || initialPlan.kind === 'upsert') {
      const mutation = await this.#dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(config) {
          const currentPlan = planNotificationRouting(config, desired, receipt);
          assertSafePlan(currentPlan);
          if (currentPlan.kind !== initialPlan.kind) {
            throw new Error('Notification routing changed while installation was in progress.');
          }
          return applyNotificationRoutingPlan(config, desired, currentPlan);
        },
      });
      configChanged = mutation.result === true;
    }

    let receiptAction: NotificationRoutingReconcileResult['receiptAction'] = 'none';
    if (desired.enabled) {
      const config = await this.#dependencies.readConfig();
      resolveNotificationRoute(config, desired, 'agent-system-install-verification');
      if (!receipt) {
        await this.#dependencies.receiptStore.write(createNotificationRoutingReceipt(desired));
        receiptAction = 'created';
      }
      const verified = planNotificationRouting(
        config,
        desired,
        receipt ?? createNotificationRoutingReceipt(desired),
      );
      if (verified.kind !== 'noop') {
        throw new Error('The notification route did not converge after installation.');
      }
    } else if (receipt) {
      const verified = planNotificationRouting(
        await this.#dependencies.readConfig(),
        desired,
        receipt,
      );
      if (verified.kind !== 'forget') {
        throw new Error('The owned notification route did not converge after removal.');
      }
      if (await this.#dependencies.receiptStore.remove(desired.agentId)) {
        receiptAction = 'removed';
      }
    }

    return { configChanged, plan: initialPlan, receiptAction };
  }
}

export type { NotificationRoutingReceipt };
