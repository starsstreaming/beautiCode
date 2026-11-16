import { mount, bytesSource } from 'webwallgl';
import { installFrame } from './runtime.js';
import { getSkippedScripts } from './engine.js';

installFrame(window, { mount, bytesSource, getSkippedScripts });
