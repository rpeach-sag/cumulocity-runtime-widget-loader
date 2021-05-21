/*
* Copyright (c) 2020 Software AG, Darmstadt, Germany and/or its licensors
*
* SPDX-License-Identifier: Apache-2.0
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
 */

import {Component} from "@angular/core";
import {BsModalRef} from "ngx-bootstrap/modal";
import {Alert, AlertService} from "@c8y/ngx-components";
import {RuntimeWidgetInstallerService} from "./runtime-widget-installer.service";

@Component({
    templateUrl: './runtime-widget-installer-modal.component.html'
})
export class RuntimeWidgetInstallerModalComponent {
    busy: boolean = false;

    widgetFile: FileList;

    constructor(public bsModalRef: BsModalRef, private alertService: AlertService, private widgetInstallerService: RuntimeWidgetInstallerService) {}

    async upload() {
        try {
            const widgetFile = this.widgetFile.item(0);
            if (!widgetFile) {
                this.alertService.danger("No widget file selected");
                return;
            }
            if(widgetFile.name && widgetFile.name.indexOf(' ') >= 0) {
                this.alertService.danger("Widget File name cannot contain SPACE");
                return;
            }

            this.busy = true;

            let currentAlert: Alert = {
                text: "Uploading widget...",
                type: "info"
            }
            this.alertService.add(currentAlert);

            await this.widgetInstallerService.installWidget(widgetFile, (msg, type) => {
                this.alertService.remove(currentAlert);
                currentAlert = {
                    text: msg,
                    type: (type ?  type: "info")
                }
                this.alertService.add(currentAlert);
            });

            this.alertService.remove(currentAlert);
            this.alertService.success("Widget Added! Refreshing...");

            // Give cumulocity a chance to load the file
            await new Promise<void>((resolve => setTimeout(() => resolve(), 5000)));

            // TODO: Technically we could just load the widget here... but current we don't support loading multiple times (See todo in loader code)
            location.reload();
        } catch(e) {
            this.alertService.danger("Failed to add widget!", e.message);
            console.error(e);
            this.busy = false;
        }
    }
}
