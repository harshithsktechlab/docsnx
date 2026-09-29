/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MODULE ICONS — the one per-module thing moduleRegistry.js can't derive  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Record modules are keyed by their module KEY (the master document table in
 * src/lib/documentCategories.ts); utility modules by their `path`, since they
 * have no taxonomy key.
 *
 * This lived inside the Shell component, which meant the sidebar was the only
 * place in the app that could show a module's icon. The mobile module list and
 * the module landing page had to fall back to printing `moduleNo` — a bare
 * ordinal that reads as a bullet number and tells the user nothing about the
 * category. They now render from here too.
 *
 * Client-only: these are React components. Every consumer is a `'use client'`
 * module.
 */
import {
  Award,
  BadgeCheck,
  Banknote,
  Briefcase,
  Building2,
  Car,
  CreditCard,
  FileCheck2,
  FileSignature,
  FileText,
  GraduationCap,
  HeartPulse,
  KeyRound,
  Gavel,
  Handshake,
  Landmark,
  Lightbulb,
  ListTodo,
  Megaphone,
  PhoneCall,
  Package,
  Receipt,
  ScrollText,
  ShieldCheck,
  UserCheck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';

export const MODULE_ICON_MAP: Readonly<Record<string, LucideIcon>> = {
  // Utility modules — keyed by path
  '/profile': UserCheck,
  '/users': Users,
  '/passwords': KeyRound,
  '/todos': ListTodo,
  '/important-contacts': PhoneCall,
  // The 14 master modules — keyed by moduleKey
  identity: FileText,
  bank_investments: CreditCard,
  insurance: FileCheck2,
  property_legal: FileSignature,
  education: GraduationCap,
  health_medical: HeartPulse,
  employment: Briefcase,
  vehicle: Car,
  civil_government: Landmark,
  warranty_amc: ShieldCheck,
  rentals_subscriptions: FileSignature,
  utility_bills: Receipt,
  tax_compliance: Receipt,

  // The 14 business modules. Distinct silhouettes matter more here than in the
  // personal set: a business user sees all fourteen in one sidebar, where a
  // second Building or a third Receipt reads as a rendering bug.
  biz_registration: Building2,
  biz_tax: Receipt,
  biz_finance: Banknote,
  biz_banking: Landmark,
  biz_licenses: BadgeCheck,
  biz_compliance: ScrollText,
  biz_contracts: Handshake,
  biz_hr: Users,
  biz_ip: Lightbulb,
  biz_insurance: ShieldCheck,
  biz_governance: Gavel,
  biz_procurement: Package,
  biz_sales: Megaphone,
  biz_operations: Warehouse,
};

/**
 * The icon for a module key or a utility module's path.
 *
 * Falls back to a generic document rather than rendering nothing: a module
 * added to the taxonomy without an entry here still gets a badge the same size
 * as its neighbours, so the list does not go ragged.
 */
export function moduleIcon(keyOrPath: string): LucideIcon {
  return MODULE_ICON_MAP[keyOrPath] || FileText;
}
