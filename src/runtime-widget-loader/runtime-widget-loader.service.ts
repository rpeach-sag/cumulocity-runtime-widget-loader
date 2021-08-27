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

import {
    Compiler,
    ComponentFactory,
    Injectable,
    Injector,
    NgModuleRef
} from "@angular/core";
import {
    DynamicComponentDefinition,
    HOOK_COMPONENTS,
    DynamicComponentComponent,
    DynamicComponentService, AlertService, AppStateService, Alert
} from "@c8y/ngx-components";
import {BehaviorSubject, of} from "rxjs";
import {filter, first, switchMap} from "rxjs/operators";
import corsImport from "webpack-external-import/corsImport";
import { IApplication, FetchClient, InventoryService } from "@c8y/client";
import {contextPathFromURL} from "../runtime-widget-installer/runtime-widget-installer.service";
import { UpdateableAlert } from './UpdateableAlert';

interface WidgetComponentFactoriesAndInjector {
    componentFactory: ComponentFactory<any>,
    configComponentFactory?: ComponentFactory<any>,
    injector: Injector
}

@Injectable({providedIn: 'root'})
export class RuntimeWidgetLoaderService {
    isLoaded$ = new BehaviorSubject(false);
    widgetFactories = new Map<string, WidgetComponentFactoriesAndInjector>();

    private fetchClient: FetchClient;
    private invService: InventoryService;
    constructor(private compiler: Compiler, private injector: Injector, private alertService: AlertService, private appStateService: AppStateService) {
        // Don't seem to be able to inject this normally - results in an import from @c8y/client/lib/src/core, I think this is an angular/typescript compiler bug
        this.fetchClient = this.injector.get(FetchClient);
        this.invService =  this.injector.get(InventoryService);
        this.monkeyPatch();
    }

    monkeyPatch() {
        const runtimeWidgetLoaderService = this;
        // Workaround to access private method of c8y
        (DynamicComponentComponent.prototype as any).loadComponent = function (dynamicComponent) {
            try {
                this.error = undefined;
                if ((dynamicComponent as any).isRuntimeLoaded) {
                    const {componentFactory, configComponentFactory, injector} = runtimeWidgetLoaderService.widgetFactories.get(this.componentId)
                    this.host.clear();
                    const componentRef = this.host.createComponent(this.mode === 'component' ? componentFactory : configComponentFactory, undefined, injector);
                    componentRef.instance.config = this.config;
                } else {
                    const componentFactory = this.componentFactoryResolver.resolveComponentFactory(this.mode === 'component' ? dynamicComponent.component : dynamicComponent.configComponent);
                    this.host.clear();
                    const componentRef = this.host.createComponent(componentFactory);
                    componentRef.instance.config = this.config;
                }
            }
            catch (ex) {
                this.error = ex;
            }
        };
        
        DynamicComponentComponent.prototype.ngOnChanges = function () {
            this.dynamicComponentService
                .getById$(this.componentId)
                // If the component isn't recognised then delay the widget load until the runtimeLoadedWidgets have loaded
                .pipe(switchMap(cmp => {
                    if (cmp === undefined || (cmp as any).isRuntimeLoaded) {
                        return runtimeWidgetLoaderService.isLoaded$.pipe(
                            filter(loaded => loaded),
                            first(), // TODO: We could support multiple loads by removing this.... however without something to tear down the subscription we'd have a memory leak
                            switchMap(() => this.dynamicComponentService
                                .getById$(this.componentId))
                        );
                    } else {
                        return of(cmp);
                    }
                })).subscribe(cmp => this.loadComponent(cmp));
        };
    }

    async loadRuntimeWidgets() {
        // Wait for login
        const user = await this.appStateService.currentUser.pipe(filter(user => user != null), first()).toPromise();
        const loadingAlert = new UpdateableAlert(this.alertService);
        loadingAlert.update('Please wait! Loading...');
        // Find the current app so that we can pull a list of installed widgets from it
        const appList = (await (await this.fetchClient.fetch(`/application/applicationsByUser/${encodeURIComponent(user.userName)}?pageSize=2000`)).json()).applications;
        
        // Updated to check for own app builder first
        let app: IApplication & {widgetContextPaths?: string[]} | undefined = appList.find(app => app.contextPath === contextPathFromURL() &&
        app.availability === 'PRIVATE') ;
        if (!app) {
            // Own App builder not found. Looking for subscribed one
            app = appList.find(app => app.contextPath === contextPathFromURL());
            if(!app) { throw Error('Could not find current application.');}
        } 
        const AppRuntimePathList = (await this.invService.list( {pageSize: 2000, query: `type eq app_runtimeContext`})).data;
        const AppRuntimePath: IAppRuntimeContext & {widgetContextPaths?: string[]} = AppRuntimePathList.find(path => path.appId === app.id);
        
        const contextPaths = Array.from(new Set([
            ...(app && app.widgetContextPaths) || [],
            ...(AppRuntimePath && AppRuntimePath.widgetContextPaths) || []
        ]));
        const jsModules = [];
        const cleanupWidgetContextPath = [];
        let widgetCounter = 0;
        for (const contextPath of contextPaths) {
            // Import every widget's importManifest.js
            // The importManifest is a mapping from exported module name to webpack chunk file
            if(contextPath && contextPath.length > 0) {
                widgetCounter ++
                loadingAlert.update(`Please wait! \nLoading widgets ${widgetCounter} of ${contextPaths.length} ...`);
                try {
                    await corsImport(`/apps/${contextPath}/importManifest.js?${Date.now()}`);
                } catch(e) {
                    if (appList.some(app => app.contextPath === contextPath)) {
                        console.error(`Unable to find widget manifest: /apps/${contextPath}/importManifest.js\n`, e);
                    } else {
                        cleanupWidgetContextPath.push(contextPath);
                    }
                    continue;
                }
    
                // Load the jsModules containing the custom widgets
                try {
                    // @ts-ignore
                    const jsModule = await __webpack_require__.interleaved(`${contextPath}/${contextPath}-CustomWidget`);
                    jsModules.push(jsModule);
                } catch (e) {
                    console.error(`Module: ${contextPath}, did not contain a custom widget\n`, e);
                    this.alertService.danger('Failed to load a runtime custom widget, it may have been compiled for a different Cumulocity version.', e.message);
                    continue;
                }
            }
        }

        loadingAlert.update('Please wait! Still Working...');
        // Create a list of all of the ngModules within the jsModules
        const ngModules: NgModuleRef<unknown>[] = [];
        for (const jsModule of jsModules) {
            for (const key of Object.keys(jsModule)) {
                const exportedObj = jsModule[key];
                // Check if the exportedObj is an angular module
                if (exportedObj.hasOwnProperty('__annotations__') && exportedObj.__annotations__.some(annotation => annotation.__proto__.ngMetadataName === "NgModule")) {
                    try {
                        // Compile the angular module
                        const ngModuleFactory = await this.compiler.compileModuleAsync(exportedObj);
                        // Create an instance of the module
                        const ngModule = ngModuleFactory.create(this.injector);
                        ngModules.push(ngModule);
                    } catch(e) {
                        console.error(`Failed to compile widgets in module:`, jsModule, '\n', e);
                        this.alertService.danger('Failed to load runtime custom widget, it may have been compiled for a different Cumulocity version.', e.message);
                        continue;
                    }
                }
            }
        }

        // Have to wait until after angularJS is loaded to get the DynamicComponentService so we can't have it injected into the constructor, instead get from the injector
        const dynamicComponentService = this.injector.get(DynamicComponentService);

        // Wait for the statically loaded widgets to load... it can take a while for the angularJS ones to be resolved!
        // It is much easier to check static widgets have loaded (they all load at once) before we start loading the runtime widgets
        // Note: We don't have to wait for the state to reach a fixed size, it is enough for the first item to enter because:
        //  All static widgets load in the same event loop cycle - promise will resolve in the next cycle
        await dynamicComponentService.state$.pipe(filter(state => state.size > 0), first()).toPromise()

        loadingAlert.update('Please wait! Almost ready...');
        // Pull out all of the widgets from those angular modules and add them to cumulocity
        for (const ngModule of ngModules) {
            const widgets = ngModule.injector.get<(DynamicComponentDefinition | DynamicComponentDefinition[])[]>(HOOK_COMPONENTS) || [];

            // Add the widget components into cumulocity
            for (const widget of widgets) {
                if (Array.isArray(widget)) {
                    for (const singleWidget of widget) {
                        this.loadWidget(ngModule, dynamicComponentService, singleWidget);
                    }
                } else {
                    this.loadWidget(ngModule, dynamicComponentService, widget);
                }
            }
        }

        loadingAlert.close();
        this.isLoaded$.next(true);

        // Auto Clean deleted widget from runtime context
        let isContextPathChanged = false;
        cleanupWidgetContextPath.forEach(contextPath => {
            if(AppRuntimePath && AppRuntimePath.widgetContextPaths) {
                const contextPathIndex = AppRuntimePath.widgetContextPaths.indexOf(contextPath);
                if(contextPathIndex >= 0){
                    AppRuntimePath.widgetContextPaths.splice(contextPathIndex, 1);
                    isContextPathChanged = true;
                }
            }
        });
        if(isContextPathChanged){
            let widgetContextPaths = [];
            widgetContextPaths = [...AppRuntimePath.widgetContextPaths];
            await this.invService.update({
                id: AppRuntimePath.id,
                widgetContextPaths
            })
        }
        
    }

    loadWidget(ngModule: NgModuleRef<unknown>, dynamicComponentService: DynamicComponentService, widget: DynamicComponentDefinition) {
        (widget as any).isRuntimeLoaded = true;

        try {
            this.widgetFactories.set(widget.id, {
                componentFactory: ngModule.componentFactoryResolver.resolveComponentFactory(widget.component),
                ...widget.configComponent && {configComponentFactory: ngModule.componentFactoryResolver.resolveComponentFactory(widget.configComponent)},
                injector: ngModule.injector
            });

            dynamicComponentService.add(widget);
        } catch (e) {
            console.error(`Failed to load runtime widget:`, widget, '\n', e);
            this.alertService.danger('Failed to load runtime custom widget, it may have been compiled for a different Cumulocity version.', e.message);
        }
    }

    /**
     * Remove a widget from application. Widget will not be deleted from Cumulocity but removed from given Application
     * Widget can be uninstall paremenently from Administration App
     * @param widgetFile
     * @param onUpdate
     */    
     async removeWidgetFromApp(appId:any, contextPath: string) {
        const AppRuntimePaths = (await this.invService.list( {pageSize: 2000, query: `( type eq app_runtimeContext and appId eq '${appId}' `})).data;
        if(AppRuntimePaths && AppRuntimePaths.length > 0) {
            const appRuntimePath = AppRuntimePaths[0];
            if(appRuntimePath && appRuntimePath.widgetContextPaths) {
                const contextPathIndex = appRuntimePath.widgetContextPaths.indexOf(contextPath);
                if(contextPathIndex >= 0){
                    let widgetContextPaths = [];
                    appRuntimePath.widgetContextPaths.splice(contextPathIndex, 1);
                    widgetContextPaths = [...appRuntimePath.widgetContextPaths];
                    await this.invService.update({
                        id: appRuntimePath.id,
                        widgetContextPaths
                    })
                }
            }
        }    
    }
}
export interface IAppRuntimeContext {
    id?: any;
    widgetContextPaths?: any;
    type?: string;
    appId?: string;
}