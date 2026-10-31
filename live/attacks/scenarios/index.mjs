import { approvalScenarios } from './approval.mjs';
import { paymentScenarios } from './payments.mjs';
import { badgeScenarios } from './badges.mjs';
import { guardScenarios } from './guard.mjs';
import { evidenceScenarios } from './evidence.mjs';

export const scenarios = [...approvalScenarios, ...paymentScenarios, ...badgeScenarios,
  ...guardScenarios, ...evidenceScenarios].sort((a, b) => Number(a.id) - Number(b.id));
