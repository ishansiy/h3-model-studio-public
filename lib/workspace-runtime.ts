import {env} from "./node-runtime";
import {workspaceOwner} from "./workspace";
export function getWorkspaceOwner(){return workspaceOwner({BOOTSTRAP_OWNER_ID:env.BOOTSTRAP_OWNER_ID});}
