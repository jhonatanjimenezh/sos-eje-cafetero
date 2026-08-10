import { Module } from '@nestjs/common';
import { PrivatePetsController, PublicPetsController } from './pets.controller';
import { PetsOriginGuard } from './pets-origin.guard';
import { PetsService } from './pets.service';

@Module({
  controllers: [PublicPetsController, PrivatePetsController],
  providers: [PetsService, PetsOriginGuard],
  exports: [PetsService],
})
export class PetsModule {}
