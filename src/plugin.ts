import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { UsageDial } from "./actions/dial";

streamDeck.logger.setLevel(LogLevel.DEBUG);
streamDeck.logger.info("claudeusage plugin started.");

streamDeck.actions.registerAction(new UsageDial());
streamDeck.connect();
