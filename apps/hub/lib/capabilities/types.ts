export type CapabilityKind = "skill" | "plugin";

export interface SkillOrigin {
  hash: string;
  id: string;
  modified?: boolean;
  registry: "skills.sh";
  registryHash?: string;
}

export interface CapabilitySkill {
  content: string;
  description: string;
  files: Record<string, string>;
  name: string;
}

export interface CapabilityInput {
  description: string;
  kind: CapabilityKind;
  name: string;
  skills: CapabilitySkill[];
  version?: string;
}

export type PublicCapability = Omit<CapabilityInput, "version"> & {
  id: string;
  version: string | null;
  enabled: boolean;
  origin?: SkillOrigin | null;
};

// UI-facing name retained for the capabilities panel and other clients.
export type Capability = PublicCapability;

export type RuntimeSkill = CapabilitySkill;
