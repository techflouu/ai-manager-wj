import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { D1Service } from './d1.service';

@Module({
  imports: [ConfigModule],
  providers: [D1Service],
  exports: [D1Service],
})
export class D1Module {}
