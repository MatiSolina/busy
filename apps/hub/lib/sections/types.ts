export interface Section {
  botSlugs: string[];
  id: string;
  name: string;
}

export class SectionConflictError extends Error {
  constructor(message = "A section with that name already exists.") {
    super(message);
    this.name = "SectionConflictError";
  }
}

export class SectionNotFoundError extends Error {
  constructor() {
    super("Section not found.");
    this.name = "SectionNotFoundError";
  }
}

export class BotNotFoundError extends Error {
  constructor() {
    super("Bot not found.");
    this.name = "BotNotFoundError";
  }
}
