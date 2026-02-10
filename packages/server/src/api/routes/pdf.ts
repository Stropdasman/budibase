import * as controller from "../controllers/pdf"
import { authorizedMiddleware as authorized } from "../../middleware/authorized"
import { PermissionLevel, PermissionType } from "@budibase/types"
import { endpointGroupList } from "./endpointGroups"

const routes = endpointGroupList.group({
  middleware: authorized(PermissionType.WORKSPACE, PermissionLevel.READ),
  first: false,
})

routes.post("/api/pdf/inline-images", controller.inlineImages)
