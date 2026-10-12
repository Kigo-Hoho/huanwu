import { Module } from '@nestjs/common';
import { AfterSalesModule } from '../after-sales/after-sales.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceCleanupService } from './evidence-cleanup.service.js';
import { EvidenceImageValidator } from './evidence-image-validator.js';
import { EvidenceService, REPORT_EVIDENCE_AUTHORIZATION, ReportEvidenceAuthorization } from './evidence.service.js';
import { EVIDENCE_STORAGE_PORT } from './evidence-storage.port.js';
import { LocalPrivateEvidenceAdapter, UnavailablePrivateEvidenceAdapter } from './local-private-evidence.adapter.js';
@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, AfterSalesModule],
  controllers: [EvidenceController],
  providers: [EvidenceService, EvidenceImageValidator, EvidenceCleanupService, ReportEvidenceAuthorization,
    { provide: REPORT_EVIDENCE_AUTHORIZATION, useExisting: ReportEvidenceAuthorization },
    { provide: EVIDENCE_STORAGE_PORT, useFactory: () => ['development', 'test'].includes(process.env.NODE_ENV ?? '') ? new LocalPrivateEvidenceAdapter() : new UnavailablePrivateEvidenceAdapter() },
  ],
  exports: [EvidenceService, EvidenceCleanupService, EVIDENCE_STORAGE_PORT, REPORT_EVIDENCE_AUTHORIZATION],
})
export class EvidenceModule {}
