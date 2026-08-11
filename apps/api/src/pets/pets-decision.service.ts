import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { PetFinderAction, PetOwnerAction } from './dto';

@Injectable()
export class PetsDecisionService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  private assertEnabled() {
    if (process.env.FEATURE_PET_SAFETY !== 'true') {
      throw new ServiceUnavailableException('Mascotas seguras está deshabilitado temporalmente');
    }
  }

  private ownerActionName(action: PetOwnerAction) {
    return {
      [PetOwnerAction.AUTHORIZE_CONTACT]: 'OWNER_AUTHORIZE_CONTACT',
      [PetOwnerAction.REJECT]: 'OWNER_REJECT',
      [PetOwnerAction.BLOCK]: 'OWNER_BLOCK',
      [PetOwnerAction.REPORT_ABUSE]: 'OWNER_REPORT_ABUSE',
    }[action];
  }

  private finderActionName(action: PetFinderAction) {
    return {
      [PetFinderAction.ACCEPT_OWNER]: 'FINDER_ACCEPT_OWNER',
      [PetFinderAction.REJECT_OWNER]: 'FINDER_REJECT_OWNER',
      [PetFinderAction.BLOCK_OWNER]: 'FINDER_BLOCK_OWNER',
      [PetFinderAction.REPORT_ABUSE]: 'FINDER_REPORT_ABUSE',
    }[action];
  }

  private async audit(
    client: PoolClient,
    actorSubject: string,
    action: string,
    claimId: string,
  ) {
    await client.query(`INSERT INTO audit_events(actor_subject,action,entity_type,entity_id,metadata)
      VALUES($1,$2,'PET_CLAIM',$3,'{}'::jsonb)`, [actorSubject, action, claimId]);
  }

  async ownerAction(subject: string, claimPublicId: string, action: PetOwnerAction) {
    this.assertEnabled();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT cl.id,cl.claimant_subject,cl.status
        FROM pet_claims cl
        JOIN pet_cases c ON c.id=cl.case_id AND c.kind='LOST'
        JOIN pet_profiles p ON p.id=c.pet_profile_id AND p.owner_auth_subject=$1
        WHERE cl.public_id=$2
        FOR UPDATE OF cl`, [subject, claimPublicId]);
      if (!r.rowCount) throw new NotFoundException('Solicitud privada no disponible');
      const claim = r.rows[0];

      if (action === PetOwnerAction.AUTHORIZE_CONTACT) {
        if (claim.status !== 'EVIDENCE_READY') {
          throw new BadRequestException('Debe existir una prueba de vida validada antes de autorizar contacto');
        }
        const proof = await client.query(`SELECT 1 FROM pet_claim_evidence
          WHERE claim_id=$1 AND kind='PROOF_OF_LIFE' AND upload_status='READY' LIMIT 1`, [claim.id]);
        if (!proof.rowCount) throw new BadRequestException('Prueba de vida validada no disponible');
      }

      const dbAction = this.ownerActionName(action);
      await client.query(`INSERT INTO pet_claim_actions(claim_id,actor_subject,action)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [claim.id, subject, dbAction]);
      if (action === PetOwnerAction.BLOCK || action === PetOwnerAction.REPORT_ABUSE) {
        await client.query(`INSERT INTO pet_blocks(blocker_subject,blocked_subject,context)
          VALUES($1,$2,'PET_CLAIM') ON CONFLICT DO NOTHING`, [subject, claim.claimant_subject]);
      }
      await this.audit(client, subject, `PET_${dbAction}`, claim.id);
      await client.query('COMMIT');

      return action === PetOwnerAction.AUTHORIZE_CONTACT
        ? {
            status: 'CONTACT_AUTHORIZED',
            warning: 'Solo autorizaste compartir tu teléfono OTP-verificado con esta reclamación. No se comparte tu domicilio ni ubicación.',
          }
        : {
            status: 'ACTION_RECORDED',
            notice: 'Esta decisión privada no genera recibo de rechazo, bloqueo o abuso para la contraparte.',
          };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async finderAction(subject: string, claimPublicId: string, action: PetFinderAction) {
    this.assertEnabled();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT cl.id,cl.claimant_subject,cl.status
        FROM pet_claims cl
        JOIN pet_cases c ON c.id=cl.case_id AND c.kind='FOUND' AND c.created_by_subject=$1
        WHERE cl.public_id=$2
        FOR UPDATE OF cl`, [subject, claimPublicId]);
      if (!r.rowCount) throw new NotFoundException('Reclamación privada no disponible');
      const claim = r.rows[0];

      if (action === PetFinderAction.ACCEPT_OWNER) {
        if (claim.status !== 'EVIDENCE_READY') {
          throw new BadRequestException('Debe existir evidencia histórica validada antes de aceptar');
        }
        const evidence = await client.query(`SELECT 1 FROM pet_claim_evidence
          WHERE claim_id=$1 AND kind='OWNERSHIP_HISTORY' AND upload_status='READY' LIMIT 1`, [claim.id]);
        if (!evidence.rowCount) throw new BadRequestException('Evidencia histórica validada no disponible');
      }

      const dbAction = this.finderActionName(action);
      await client.query(`INSERT INTO pet_claim_actions(claim_id,actor_subject,action)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [claim.id, subject, dbAction]);
      if (action === PetFinderAction.BLOCK_OWNER || action === PetFinderAction.REPORT_ABUSE) {
        await client.query(`INSERT INTO pet_blocks(blocker_subject,blocked_subject,context)
          VALUES($1,$2,'PET_CLAIM') ON CONFLICT DO NOTHING`, [subject, claim.claimant_subject]);
      }
      await this.audit(client, subject, `PET_${dbAction}`, claim.id);
      await client.query('COMMIT');

      return action === PetFinderAction.ACCEPT_OWNER
        ? {
            status: 'OWNER_CLAIM_ACCEPTED',
            notice: 'La aceptación habilita únicamente los contactos que cada parte haya consentido compartir.',
          }
        : {
            status: 'ACTION_RECORDED',
            notice: 'La decisión privada no produce un recibo de rechazo, bloqueo o abuso visible para la contraparte.',
          };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}
