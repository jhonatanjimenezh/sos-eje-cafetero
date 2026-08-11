import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class PetsContactService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private assertEnabled() {
    if (process.env.FEATURE_PET_SAFETY !== 'true') {
      throw new ServiceUnavailableException('Mascotas seguras está deshabilitado temporalmente');
    }
  }

  private async audit(subject: string, action: string, claimId: string) {
    try {
      await this.db.query(
        `INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
         VALUES($1,$2,'PET_CLAIM',$3,'{}'::jsonb)`,
        [subject, action, claimId],
      );
    } catch {
      throw new ServiceUnavailableException('Auditoría de seguridad temporalmente no disponible');
    }
  }

  async ownerGetsFinderContact(ownerSubject: string, claimPublicId: string) {
    this.assertEnabled();
    const r = await this.db.query(`SELECT cl.id,cl.claimant_subject,cl.share_claimant_phone,cl.status
      FROM pet_claims cl
      JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
      JOIN pet_profiles p ON p.id=c.pet_profile_id AND p.owner_auth_subject=$1
      WHERE cl.public_id=$2 AND cl.claimant_role='FINDER'`, [ownerSubject, claimPublicId]);
    if (!r.rowCount) throw new NotFoundException('Claim no disponible');
    const claim = r.rows[0];
    if (claim.status !== 'EVIDENCE_READY' || !claim.share_claimant_phone) {
      return { status: 'NOT_AVAILABLE' };
    }

    const proof = await this.db.query(`SELECT 1 FROM pet_claim_evidence
      WHERE claim_id=$1 AND kind='PROOF_OF_LIFE' AND upload_status='READY' LIMIT 1`, [claim.id]);
    if (!proof.rowCount) return { status: 'NOT_AVAILABLE' };

    const finder = await this.db.query('SELECT phone_e164 FROM auth_identities WHERE subject=$1', [claim.claimant_subject]);
    if (!finder.rowCount) return { status: 'NOT_AVAILABLE' };

    await this.audit(ownerSubject, 'PET_OWNER_RETRIEVED_CONSENTED_FINDER_CONTACT', claim.id);
    return {
      status: 'CONTACT_AVAILABLE',
      phone: finder.rows[0].phone_e164,
      warning: 'Esta persona consintió compartir su teléfono después de aportar una prueba de vida. Verifica nuevamente el video y coordina la entrega en un punto seguro. No envíes dinero por adelantado.',
    };
  }
}
