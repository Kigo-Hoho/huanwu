import type { ResolutionAdjudicationInput, ResolutionInput } from '@barter/contracts';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { ResolutionService } from './resolution.service.js';

@Injectable()
export class AdminAfterSalesService {
  constructor(@Inject(ResolutionService) private readonly resolutions: ResolutionService) {}
  propose(operator: OperatorSessionContext, caseId: string, input: ResolutionInput, key: string) {
    return this.resolutions.propose(operator, caseId, input, key);
  }
  adjudicate(operator: OperatorSessionContext, caseId: string, input: ResolutionAdjudicationInput, key: string) {
    if (input.operatorAction.sessionId !== operator.sessionId) throw new ForbiddenException({ code: 'GRANT_INVALID', message: 'Grant must use the current bound session' });
    return this.resolutions.adjudicate({ ...operator, grantId: input.operatorAction.grantId }, { ...input, caseId }, key);
  }
}
